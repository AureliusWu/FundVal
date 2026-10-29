// Keep the original module's public/test API, but constrain the lazy UI surface.
export {
  synchronizeHoldingsCloud,
  pullHoldingsCloud,
  canonicalCloudPayload,
  makeCloudWritePayload,
  finalizeCreatedArchiveState,
  finalizeCloudSyncMetadata,
} from './cloud-sync.js';
