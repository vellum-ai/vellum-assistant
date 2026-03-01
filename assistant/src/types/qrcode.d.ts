declare module 'qrcode' {
  interface QRCodeToBufferOptions {
    type?: 'png';
    width?: number;
  }

  function toBuffer(text: string, options?: QRCodeToBufferOptions): Promise<Buffer>;

  export default { toBuffer };
}
