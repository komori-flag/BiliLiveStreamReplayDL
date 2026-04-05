declare namespace Bun {
  /**
   * Calculates CRC32 checksum for the given data.
   * Returns a 32-bit unsigned integer.
   */
  export function CRC32(data: ArrayBuffer | Uint8Array | string): number;
}
