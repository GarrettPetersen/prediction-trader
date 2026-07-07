import type {
  WeatherObservationRecord,
  WeatherPreviousRunForecastRecord,
  WeatherResolutionActualRecord
} from "./weatherDatasets.js";
import type { WeatherMeasure } from "./weatherMarkets.js";
import {
  weatherCityTargetKey,
  weatherStationTargetKey
} from "./weatherStations.js";

export interface WeatherActualIndexValue {
  maxTempC?: number;
  minTempC?: number;
}

export interface WeatherSourceForecastValue {
  source: string;
  valueC: number;
}

export interface WeatherWeightedValue {
  value: number;
  weight: number;
}

export interface WeatherSourceCalibration {
  biasC: number;
  sigmaC: number;
  meanAbsoluteErrorC: number;
  samples: number;
  effectiveWeight: number;
  ensembleWeight: number;
}

export interface WeatherForecastCalibration {
  biasC: number;
  sigmaC: number;
  meanAbsoluteErrorC: number;
  samples: number;
  halfLifeDays: number;
  cityBiasPriorWeight: number;
  cityBiases: Map<string, { biasC: number; samples: number; effectiveWeight: number }>;
  sourceCalibrations: Map<string, WeatherSourceCalibration>;
}

export interface WeatherForecastAggregate {
  meanC: number;
  rawMeanC: number;
  sourceCount: number;
}

export interface WeatherCalibrationSummary {
  measure: WeatherMeasure;
  samples: number;
  biasC: number;
  sigmaC: number;
  meanAbsoluteErrorC: number;
  halfLifeDays: number;
  cityBiases: number;
  sourceWeights: Record<string, number>;
  sourceBiasC: Record<string, number>;
}

interface ResidualSample {
  cityKey: string;
  date: string;
  residualC: number;
  weight: number;
}

export const DEFAULT_CALIBRATION_HALF_LIFE_DAYS = 365;
export const DEFAULT_CITY_BIAS_PRIOR_WEIGHT = 30;
const SOURCE_CALIBRATION_PRIOR_SAMPLES = 30;

export function weatherObservationKey(targetKey: string, date: string): string {
  return `${targetKey}|${date}`;
}

export function weatherForecastKey(targetKey: string, date: string, measure: WeatherMeasure): string {
  return `${targetKey}|${date}|${measure}`;
}

export function previousRunRecordTargetKey(record: WeatherPreviousRunForecastRecord): string {
  return record.targetKey ?? weatherCityTargetKey(record.city);
}

export function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length);
}

function weightedMean(values: WeatherWeightedValue[]): number {
  const weightTotal = values.reduce((sum, item) => sum + item.weight, 0);
  if (weightTotal <= 0) return mean(values.map((item) => item.value));
  return values.reduce((sum, item) => sum + item.value * item.weight, 0) / weightTotal;
}

function weightedStdDev(values: WeatherWeightedValue[], center = weightedMean(values)): number {
  const weightTotal = values.reduce((sum, item) => sum + item.weight, 0);
  if (weightTotal <= 0) return stdDev(values.map((item) => item.value));
  return Math.sqrt(values.reduce((sum, item) => sum + ((item.value - center) ** 2) * item.weight, 0) / weightTotal);
}

function weightedMeanAbsolute(values: WeatherWeightedValue[]): number {
  const weightTotal = values.reduce((sum, item) => sum + item.weight, 0);
  if (weightTotal <= 0) return mean(values.map((item) => Math.abs(item.value)));
  return values.reduce((sum, item) => sum + Math.abs(item.value) * item.weight, 0) / weightTotal;
}

function daysBetween(olderDate: string, newerDate: string): number {
  const older = Date.parse(`${olderDate}T00:00:00Z`);
  const newer = Date.parse(`${newerDate}T00:00:00Z`);
  if (!Number.isFinite(older) || !Number.isFinite(newer)) return 0;
  return Math.max(0, (newer - older) / 86_400_000);
}

function recencyWeight(date: string, targetDate: string, halfLifeDays: number): number {
  const halfLife = Math.max(1, halfLifeDays);
  return 0.5 ** (daysBetween(date, targetDate) / halfLife);
}

export function actualValueForMeasure(
  actual: WeatherActualIndexValue | undefined,
  measure: WeatherMeasure
): number | undefined {
  if (!actual) return undefined;
  return measure === "temperature_high" ? actual.maxTempC : actual.minTempC;
}

function setActualIndexValue(
  index: Map<string, WeatherActualIndexValue>,
  targetKey: string,
  date: string,
  measure: WeatherMeasure,
  valueC: number | undefined
): void {
  if (valueC === undefined) return;
  const key = weatherObservationKey(targetKey, date);
  const existing = index.get(key) ?? {};
  index.set(key, {
    maxTempC: measure === "temperature_high" ? valueC : existing.maxTempC,
    minTempC: measure === "temperature_low" ? valueC : existing.minTempC
  });
}

export function buildWeatherActualIndex(
  records: WeatherObservationRecord[],
  resolutionActuals: WeatherResolutionActualRecord[]
): Map<string, WeatherActualIndexValue> {
  const index = new Map<string, WeatherActualIndexValue>();
  for (const record of records) {
    const key = weatherObservationKey(weatherCityTargetKey(record.city), record.date);
    const existing = index.get(key) ?? {};
    index.set(key, {
      maxTempC: record.maxTempC ?? existing.maxTempC,
      minTempC: record.minTempC ?? existing.minTempC
    });
  }
  for (const record of resolutionActuals) {
    const valueC = record.extremeC?.resolution ?? record.extremeC?.wunderground ?? record.extremeC?.metar;
    const stationTarget = weatherStationTargetKey(record.resolutionStationId);
    if (stationTarget) {
      setActualIndexValue(index, stationTarget, record.date, record.measure, valueC);
    }
    setActualIndexValue(index, weatherCityTargetKey(record.city), record.date, record.measure, valueC);
  }
  return index;
}

export function buildPreviousRunForecastValueIndex(
  records: WeatherPreviousRunForecastRecord[],
  options: { leadDays: number; sources: string[] }
): Map<string, WeatherSourceForecastValue[]> {
  const byKey = new Map<string, Map<string, WeatherSourceForecastValue>>();
  const sourceSet = new Set(options.sources);
  for (const record of records) {
    if (!record.ok || record.valueC === undefined || record.leadDays !== options.leadDays) continue;
    if (!sourceSet.has(record.source)) continue;
    const key = weatherForecastKey(previousRunRecordTargetKey(record), record.date, record.measure);
    const values = byKey.get(key) ?? new Map<string, WeatherSourceForecastValue>();
    values.set(record.source, { source: record.source, valueC: record.valueC });
    byKey.set(key, values);
  }

  return new Map([...byKey.entries()].map(([key, values]) => [key, [...values.values()]]));
}

export function aggregateCalibratedForecast(
  sourceValues: WeatherSourceForecastValue[],
  sourceCalibrations: WeatherForecastCalibration["sourceCalibrations"]
): WeatherForecastAggregate {
  const rawMeanC = mean(sourceValues.map((item) => item.valueC));
  const weightedValues = sourceValues.map((item) => {
    const calibration = sourceCalibrations.get(item.source);
    return {
      value: item.valueC + (calibration?.biasC ?? 0),
      weight: calibration?.ensembleWeight ?? 1
    };
  });
  return {
    meanC: weightedMean(weightedValues),
    rawMeanC,
    sourceCount: sourceValues.length
  };
}

export function calibrateWeatherForecasts(
  forecastValuesByKey: Map<string, WeatherSourceForecastValue[]>,
  actualIndex: Map<string, WeatherActualIndexValue>,
  targetDate: string,
  options: { halfLifeDays: number; cityBiasPriorWeight: number }
): Map<WeatherMeasure, WeatherForecastCalibration> {
  const sourceResiduals: Record<WeatherMeasure, Map<string, WeatherWeightedValue[]>> = {
    temperature_high: new Map(),
    temperature_low: new Map()
  };
  const sourceResidualPool: Record<WeatherMeasure, WeatherWeightedValue[]> = {
    temperature_high: [],
    temperature_low: []
  };

  for (const [key, sourceValues] of forecastValuesByKey.entries()) {
    const [cityKey, date, measureRaw] = key.split("|");
    if (date >= targetDate) continue;
    const measure = measureRaw as WeatherMeasure;
    const actual = actualValueForMeasure(actualIndex.get(`${cityKey}|${date}`), measure);
    if (actual === undefined) continue;
    const weight = recencyWeight(date, targetDate, options.halfLifeDays);
    for (const sourceValue of sourceValues) {
      const residual = actual - sourceValue.valueC;
      const sourceItems = sourceResiduals[measure].get(sourceValue.source) ?? [];
      sourceItems.push({ value: residual, weight });
      sourceResiduals[measure].set(sourceValue.source, sourceItems);
      sourceResidualPool[measure].push({ value: residual, weight });
    }
  }

  return new Map((["temperature_high", "temperature_low"] as const).map((measure) => {
    const sourcePool = sourceResidualPool[measure];
    const fallbackSourceBias = sourcePool.length > 0 ? weightedMean(sourcePool) : 0;
    const fallbackSourceSigma = sourcePool.length > 0
      ? Math.max(0.5, weightedStdDev(sourcePool, fallbackSourceBias))
      : 2.5;
    const sourceCalibrations = new Map<string, WeatherSourceCalibration>();

    for (const [source, values] of sourceResiduals[measure].entries()) {
      const sourceMean = weightedMean(values);
      const shrinkage = values.length / (values.length + SOURCE_CALIBRATION_PRIOR_SAMPLES);
      const biasC = fallbackSourceBias + (sourceMean - fallbackSourceBias) * shrinkage;
      const rawSigma = Math.max(0.5, weightedStdDev(values, sourceMean));
      const sigmaC = Math.sqrt(
        ((rawSigma ** 2) * values.length + (fallbackSourceSigma ** 2) * SOURCE_CALIBRATION_PRIOR_SAMPLES) /
        (values.length + SOURCE_CALIBRATION_PRIOR_SAMPLES)
      );
      sourceCalibrations.set(source, {
        biasC,
        sigmaC,
        meanAbsoluteErrorC: weightedMeanAbsolute(values),
        samples: values.length,
        effectiveWeight: values.reduce((sum, item) => sum + item.weight, 0),
        ensembleWeight: 1 / Math.max(0.25, sigmaC ** 2)
      });
    }

    const ensembleResiduals: ResidualSample[] = [];
    for (const [key, sourceValues] of forecastValuesByKey.entries()) {
      const [cityKey, date, measureRaw] = key.split("|");
      if (measureRaw !== measure || date >= targetDate) continue;
      const actual = actualValueForMeasure(actualIndex.get(`${cityKey}|${date}`), measure);
      if (actual === undefined) continue;
      const forecast = aggregateCalibratedForecast(sourceValues, sourceCalibrations);
      ensembleResiduals.push({
        cityKey,
        date,
        residualC: actual - forecast.meanC,
        weight: recencyWeight(date, targetDate, options.halfLifeDays)
      });
    }

    if (ensembleResiduals.length === 0) {
      return [measure, {
        samples: 0,
        biasC: 0,
        sigmaC: 2.5,
        meanAbsoluteErrorC: 2.5,
        halfLifeDays: options.halfLifeDays,
        cityBiasPriorWeight: options.cityBiasPriorWeight,
        cityBiases: new Map(),
        sourceCalibrations
      }];
    }

    const residualValues = ensembleResiduals.map((sample) => ({ value: sample.residualC, weight: sample.weight }));
    const globalBiasC = weightedMean(residualValues);
    const byCity = new Map<string, WeatherWeightedValue[]>();
    for (const sample of ensembleResiduals) {
      const values = byCity.get(sample.cityKey) ?? [];
      values.push({ value: sample.residualC, weight: sample.weight });
      byCity.set(sample.cityKey, values);
    }
    const cityBiases = new Map<string, { biasC: number; samples: number; effectiveWeight: number }>();
    for (const [cityKey, values] of byCity.entries()) {
      const cityWeight = values.reduce((sum, item) => sum + item.weight, 0);
      const cityMean = weightedMean(values);
      const shrinkage = cityWeight / (cityWeight + Math.max(0, options.cityBiasPriorWeight));
      cityBiases.set(cityKey, {
        biasC: globalBiasC + (cityMean - globalBiasC) * shrinkage,
        samples: values.length,
        effectiveWeight: cityWeight
      });
    }

    const centered = ensembleResiduals.map((sample) => ({
      value: sample.residualC - (cityBiases.get(sample.cityKey)?.biasC ?? globalBiasC),
      weight: sample.weight
    }));
    return [measure, {
      samples: ensembleResiduals.length,
      biasC: globalBiasC,
      sigmaC: Math.max(0.5, weightedStdDev(centered, 0)),
      meanAbsoluteErrorC: weightedMeanAbsolute(centered),
      halfLifeDays: options.halfLifeDays,
      cityBiasPriorWeight: options.cityBiasPriorWeight,
      cityBiases,
      sourceCalibrations
    }];
  }));
}

export function buildCalibratedForecastIndex(
  forecastValuesByKey: Map<string, WeatherSourceForecastValue[]>,
  calibration: Map<WeatherMeasure, WeatherForecastCalibration>
): Map<string, WeatherForecastAggregate> {
  return new Map([...forecastValuesByKey.entries()].map(([key, sourceValues]) => {
    const [, , measureRaw] = key.split("|");
    const sourceCalibrations = calibration.get(measureRaw as WeatherMeasure)?.sourceCalibrations ?? new Map();
    return [key, aggregateCalibratedForecast(sourceValues, sourceCalibrations)];
  }));
}

export function calibrationBiasForTarget(calibration: WeatherForecastCalibration, targetKey: string): number {
  return calibration.cityBiases.get(targetKey)?.biasC ?? calibration.biasC;
}

export function summarizeWeatherCalibrations(
  calibration: Map<WeatherMeasure, WeatherForecastCalibration>
): WeatherCalibrationSummary[] {
  return [...calibration.entries()].map(([measure, item]) => {
    const weightTotal = [...item.sourceCalibrations.values()]
      .reduce((sum, sourceCalibration) => sum + sourceCalibration.ensembleWeight, 0);
    return {
      measure,
      samples: item.samples,
      biasC: item.biasC,
      sigmaC: item.sigmaC,
      meanAbsoluteErrorC: item.meanAbsoluteErrorC,
      halfLifeDays: item.halfLifeDays,
      cityBiases: item.cityBiases.size,
      sourceWeights: Object.fromEntries([...item.sourceCalibrations.entries()].map(([source, sourceCalibration]) => [
        source,
        weightTotal > 0 ? sourceCalibration.ensembleWeight / weightTotal : 0
      ])),
      sourceBiasC: Object.fromEntries([...item.sourceCalibrations.entries()].map(([source, sourceCalibration]) => [
        source,
        sourceCalibration.biasC
      ]))
    };
  });
}
