export interface TextDecoderLike {
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}

export type TextDecoderCtor = new (
  label?: string,
  options?: { fatal?: boolean },
) => TextDecoderLike;

export function getTextDecoderCtor(): TextDecoderCtor {
  const ctor = (globalThis as { TextDecoder?: TextDecoderCtor }).TextDecoder;
  if (!ctor) {
    throw new Error('TextDecoder is not available in this JavaScript runtime.');
  }
  return ctor;
}

export function decodeUtf8WithGbFallback(bytes: Uint8Array): string {
  const Decoder = getTextDecoderCtor();
  try {
    return new Decoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    return new Decoder('gb18030').decode(bytes).replace(/^\uFEFF/, '');
  }
}
