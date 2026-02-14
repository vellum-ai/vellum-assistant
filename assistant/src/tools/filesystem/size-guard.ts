// Backward-compatible re-export shim — canonical module lives in shared/filesystem/
export {
  MAX_FILE_SIZE_BYTES,
  checkFileSizeOnDisk,
  checkContentSize,
} from '../shared/filesystem/size-guard.js';
