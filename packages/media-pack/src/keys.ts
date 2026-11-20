import { extensionOf } from "./file-types.js";

/**
 * Storage key conventions of the PRIVATE media library, shared by the API (which stores uploads) and the worker (which
 * stores derivatives) so they always agree. Keys are built only from server-generated ids - never from a file name the
 * client or an archive supplied (only its extension, which is on the allow-list).
 */
export const libraryKeys = {
  /** The untouched original ZIP of a pack. */
  archive: (organizationId: string, packId: string) => `${organizationId}/packs/${packId}/source.zip`,
  /** The immutable original of an asset. */
  original: (organizationId: string, assetId: string, fileName: string) => `${organizationId}/assets/${assetId}/original${extensionOf(fileName)}`,
  /** A generated file of an asset (thumbnail, preview). Stored separately, never over the original. */
  derivative: (organizationId: string, assetId: string, name: string, extension: string) => `${organizationId}/assets/${assetId}/${name}${extension}`,
} as const;