/**
 * Ocean module exports
 */

export { 
  OceanManager, 
  type OceanManagerConfig, 
  type OceanRenderParams,
  createDefaultOceanManagerConfig 
} from './OceanManager';

export {
  evaluateGerstnerHeight,
  type GerstnerHeightResult,
} from './GerstnerWaves';

// FFT Ocean (Phase W2)
export {
  FFTOceanSpectrum,
  type FFTOceanConfig,
  type SpectrumType,
  createDefaultFFTOceanConfig,
} from './FFTOceanSpectrum';

export { FFTButterflyPass } from './FFTButterflyPass';

export {
  queryOceanHeight,
  queryOceanHeightBatch,
  type OceanHeightQueryParams,
} from './OceanHeightQuery';
