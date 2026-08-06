#include "ComServer.h"
#include <shlwapi.h>
#include <thumbcache.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <algorithm>
#include <new>
using Microsoft::WRL::ComPtr;
const CLSID CLSID_VellumThumbnail = {
    0xc90464a7, 0x6608, 0x44c9, {0x89, 0x83, 0x2e, 0xa8, 0x2f, 0x10, 0xe4, 0x54}};
namespace {
HBITMAP CreateBitmap(UINT width, UINT height, void** pixels) {
  BITMAPV5HEADER header{};
  header.bV5Size = sizeof(header);
  header.bV5Width = width;
  header.bV5Height = -static_cast<LONG>(height);
  header.bV5Planes = 1;
  header.bV5BitCount = 32;
  header.bV5Compression = BI_BITFIELDS;
  header.bV5RedMask = 0x00ff0000;
  header.bV5GreenMask = 0x0000ff00;
  header.bV5BlueMask = 0x000000ff;
  header.bV5AlphaMask = 0xff000000;
  return CreateDIBSection(nullptr, reinterpret_cast<BITMAPINFO*>(&header),
                          DIB_RGB_COLORS, pixels, nullptr, 0);
}
HBITMAP DecodePng(const std::vector<std::uint8_t>& png, UINT maximum) {
  if (png.empty()) {
    return nullptr;
  }
  ComPtr<IWICImagingFactory> factory;
  if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr,
                              CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory)))) {
    return nullptr;
  }
  ComPtr<IStream> stream;
  stream.Attach(SHCreateMemStream(png.data(), static_cast<UINT>(png.size())));
  ComPtr<IWICBitmapDecoder> decoder;
  ComPtr<IWICBitmapFrameDecode> frame;
  UINT sourceWidth = 0;
  UINT sourceHeight = 0;
  if (stream == nullptr ||
      FAILED(factory->CreateDecoderFromStream(stream.Get(), nullptr,
                                              WICDecodeMetadataCacheOnLoad, &decoder)) ||
      FAILED(decoder->GetFrame(0, &frame)) ||
      FAILED(frame->GetSize(&sourceWidth, &sourceHeight)) || sourceWidth == 0 ||
      sourceHeight == 0) {
    return nullptr;
  }
  const double scale = std::min(1.0, static_cast<double>(maximum) /
                                        std::max(sourceWidth, sourceHeight));
  const UINT width = std::max(1U, static_cast<UINT>(sourceWidth * scale));
  const UINT height = std::max(1U, static_cast<UINT>(sourceHeight * scale));
  ComPtr<IWICBitmapScaler> scaler;
  ComPtr<IWICFormatConverter> converter;
  if (FAILED(factory->CreateBitmapScaler(&scaler)) ||
      FAILED(scaler->Initialize(frame.Get(), width, height,
                                WICBitmapInterpolationModeFant)) ||
      FAILED(factory->CreateFormatConverter(&converter)) ||
      FAILED(converter->Initialize(scaler.Get(), GUID_WICPixelFormat32bppPBGRA,
                                   WICBitmapDitherTypeNone, nullptr, 0,
                                   WICBitmapPaletteTypeCustom))) {
    return nullptr;
  }
  void* pixels = nullptr;
  HBITMAP bitmap = CreateBitmap(width, height, &pixels);
  const UINT stride = width * 4;
  if (bitmap == nullptr ||
      FAILED(converter->CopyPixels(nullptr, stride, stride * height,
                                   static_cast<BYTE*>(pixels)))) {
    if (bitmap != nullptr) {
      DeleteObject(bitmap);
    }
    return nullptr;
  }
  return bitmap;
}
HBITMAP Fallback(UINT size) {
  void* raw = nullptr;
  HBITMAP bitmap = CreateBitmap(size, size, &raw);
  if (bitmap == nullptr) {
    return nullptr;
  }
  auto* pixels = static_cast<std::uint32_t*>(raw);
  for (UINT y = 0; y < size; ++y) {
    const UINT shade = 70 + (80 * y / std::max(1U, size - 1));
    for (UINT x = 0; x < size; ++x) {
      pixels[y * size + x] = 0xff000000 | (shade << 16) | (70 << 8) | 190;
    }
  }
  return bitmap;
}
class ThumbnailProvider final : public IThumbnailProvider,
                                public IInitializeWithStream,
                                public RefCounted {
 public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** value) override {
    if (value == nullptr) {
      return E_POINTER;
    }
    *value = nullptr;
    if (id == IID_IUnknown || id == IID_IThumbnailProvider) {
      *value = static_cast<IThumbnailProvider*>(this);
    } else if (id == IID_IInitializeWithStream) {
      *value = static_cast<IInitializeWithStream*>(this);
    }
    if (*value == nullptr) {
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return AddRefImpl(); }
  ULONG STDMETHODCALLTYPE Release() override { return ReleaseImpl(); }
  HRESULT STDMETHODCALLTYPE Initialize(IStream* stream, DWORD) override {
    if (initialized_) {
      return HRESULT_FROM_WIN32(ERROR_ALREADY_INITIALIZED);
    }
    initialized_ = true;
    return LoadBundle(stream, bundle_);
  }
  HRESULT STDMETHODCALLTYPE GetThumbnail(UINT size, HBITMAP* bitmap,
                                         WTS_ALPHATYPE* alpha) override {
    if (bitmap == nullptr || alpha == nullptr || !bundle_ || size == 0 ||
        size > 4096) {
      return E_INVALIDARG;
    }
    *bitmap = DecodePng(bundle_.iconPng, size);
    if (*bitmap == nullptr) {
      *bitmap = Fallback(size);
    }
    if (*bitmap == nullptr) {
      return E_OUTOFMEMORY;
    }
    *alpha = WTSAT_ARGB;
    return S_OK;
  }
 private:
  bool initialized_ = false;
  vellum::BundleResult bundle_;
};
}  // namespace
IUnknown* CreateThumbnailProvider() {
  return static_cast<IThumbnailProvider*>(new (std::nothrow) ThumbnailProvider());
}
