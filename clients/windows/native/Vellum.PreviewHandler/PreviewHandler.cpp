#include "ComServer.h"
#include <algorithm>
#include <new>
#include <vector>
#include <wrl/client.h>
using Microsoft::WRL::ComPtr;
std::atomic<long> gModuleRefs{0};
const CLSID CLSID_VellumPreview = {
    0x5888df89, 0x8ad1, 0x4d76,
    {0x87, 0xc4, 0x54, 0x8a, 0x79, 0xe8, 0xc2, 0xe5}};
std::wstring Wide(std::string_view value) {
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                       static_cast<int>(value.size()), nullptr, 0);
  std::wstring result(size, L'\0');
  if (size > 0) {
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                        static_cast<int>(value.size()), result.data(), size);
  }
  return result;
}
HRESULT LoadBundle(IStream* stream, vellum::BundleResult& bundle) {
  STATSTG stat{};
  if (stream == nullptr || FAILED(stream->Stat(&stat, STATFLAG_NONAME)) ||
      stat.cbSize.HighPart != 0 || stat.cbSize.LowPart > 25 * 1024 * 1024) {
    return HRESULT_FROM_WIN32(ERROR_FILE_TOO_LARGE);
  }
  LARGE_INTEGER start{};
  if (FAILED(stream->Seek(start, STREAM_SEEK_SET, nullptr))) {
    return STG_E_SEEKERROR;
  }
  std::vector<std::uint8_t> bytes(stat.cbSize.LowPart);
  std::size_t total = 0;
  while (total < bytes.size()) {
    ULONG read = 0;
    const HRESULT status = stream->Read(bytes.data() + total,
                                        static_cast<ULONG>(bytes.size() - total), &read);
    if (FAILED(status) || read == 0) {
      return STG_E_READFAULT;
    }
    total += read;
  }
  bundle = vellum::ReadBundle(bytes.data(), bytes.size());
  return bundle ? S_OK : HRESULT_FROM_WIN32(ERROR_BAD_FORMAT);
}
class PreviewHandler final : public IPreviewHandler,
                             public IInitializeWithStream,
                             public IObjectWithSite,
                             public IOleWindow,
                             public RefCounted {
 public:
  ~PreviewHandler() override { Unload(); }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** value) override {
    if (value == nullptr) {
      return E_POINTER;
    }
    *value = nullptr;
    if (id == IID_IUnknown || id == IID_IPreviewHandler) {
      *value = static_cast<IPreviewHandler*>(this);
    } else if (id == IID_IInitializeWithStream) {
      *value = static_cast<IInitializeWithStream*>(this);
    } else if (id == IID_IObjectWithSite) {
      *value = static_cast<IObjectWithSite*>(this);
    } else if (id == IID_IOleWindow) {
      *value = static_cast<IOleWindow*>(this);
    }
    if (*value == nullptr) {
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return AddRefImpl(); }
  ULONG STDMETHODCALLTYPE Release() override { return ReleaseImpl(); }
  HRESULT STDMETHODCALLTYPE SetSite(IUnknown* site) override {
    site_ = site;
    frame_.Reset();
    if (site != nullptr) {
      site->QueryInterface(IID_PPV_ARGS(&frame_));
    }
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE GetSite(REFIID id, void** value) override {
    if (value == nullptr) {
      return E_POINTER;
    }
    *value = nullptr;
    return site_ ? site_->QueryInterface(id, value) : E_FAIL;
  }
  HRESULT STDMETHODCALLTYPE Initialize(IStream* stream, DWORD) override {
    if (initialized_) {
      return HRESULT_FROM_WIN32(ERROR_ALREADY_INITIALIZED);
    }
    initialized_ = true;
    return LoadBundle(stream, bundle_);
  }
  HRESULT STDMETHODCALLTYPE SetWindow(HWND parent, const RECT* rect) override {
    if (parent == nullptr || rect == nullptr) {
      return E_INVALIDARG;
    }
    parent_ = parent;
    if (window_ != nullptr) {
      SetParent(window_, parent);
    }
    return SetRect(rect);
  }
  HRESULT STDMETHODCALLTYPE SetRect(const RECT* rect) override {
    if (rect == nullptr) {
      return E_INVALIDARG;
    }
    rect_ = *rect;
    if (window_ != nullptr) {
      MoveWindow(window_, rect_.left, rect_.top, std::max(0L, rect_.right - rect_.left),
                 std::max(0L, rect_.bottom - rect_.top), TRUE);
    }
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE DoPreview() override {
    if (!bundle_ || parent_ == nullptr) {
      return E_UNEXPECTED;
    }
    if (window_ != nullptr) {
      return S_OK;
    }
    std::wstring text = Wide(bundle_.metadata.name);
    if (!bundle_.metadata.description.empty()) {
      text += L"\r\n\r\n" + Wide(bundle_.metadata.description);
    }
    if (!bundle_.metadata.version.empty()) {
      text += L"\r\n\r\nVersion " + Wide(bundle_.metadata.version);
    }
    text += L"\r\nCreated by " + Wide(bundle_.metadata.createdBy);
    window_ = CreateWindowExW(
        WS_EX_CLIENTEDGE, L"STATIC", text.c_str(),
        WS_CHILD | WS_VISIBLE | SS_LEFT | SS_NOPREFIX, rect_.left, rect_.top,
        rect_.right - rect_.left, rect_.bottom - rect_.top, parent_, nullptr,
        GetModuleHandleW(nullptr), nullptr);
    if (window_ == nullptr) {
      return HRESULT_FROM_WIN32(GetLastError());
    }
    SendMessageW(window_, WM_SETFONT,
                 reinterpret_cast<WPARAM>(GetStockObject(DEFAULT_GUI_FONT)), TRUE);
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE Unload() override {
    if (window_ != nullptr) {
      DestroyWindow(window_);
      window_ = nullptr;
    }
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE SetFocus() override {
    if (window_ == nullptr) {
      return S_FALSE;
    }
    ::SetFocus(window_);
    return GetFocus() == window_ ? S_OK : S_FALSE;
  }
  HRESULT STDMETHODCALLTYPE QueryFocus(HWND* window) override {
    if (window == nullptr) {
      return E_POINTER;
    }
    *window = GetFocus();
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE TranslateAccelerator(MSG* message) override {
    return frame_ ? frame_->TranslateAccelerator(message) : S_FALSE;
  }
  HRESULT STDMETHODCALLTYPE GetWindow(HWND* window) override {
    if (window == nullptr) {
      return E_POINTER;
    }
    *window = window_;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE ContextSensitiveHelp(BOOL) override { return E_NOTIMPL; }
 private:
  bool initialized_ = false;
  ComPtr<IUnknown> site_;
  ComPtr<IPreviewHandlerFrame> frame_;
  vellum::BundleResult bundle_;
  HWND parent_ = nullptr;
  HWND window_ = nullptr;
  RECT rect_{};
};
class ClassFactory final : public IClassFactory, public RefCounted {
 public:
  explicit ClassFactory(IUnknown* (*create)()) : create_(create) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** value) override {
    if (value == nullptr) {
      return E_POINTER;
    }
    *value = id == IID_IUnknown || id == IID_IClassFactory
                 ? static_cast<IClassFactory*>(this)
                 : nullptr;
    if (*value == nullptr) {
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return AddRefImpl(); }
  ULONG STDMETHODCALLTYPE Release() override { return ReleaseImpl(); }
  HRESULT STDMETHODCALLTYPE CreateInstance(IUnknown* outer, REFIID id,
                                           void** value) override {
    if (outer != nullptr) {
      return CLASS_E_NOAGGREGATION;
    }
    IUnknown* object = create_();
    if (object == nullptr) {
      return E_OUTOFMEMORY;
    }
    const HRESULT status = object->QueryInterface(id, value);
    object->Release();
    return status;
  }
  HRESULT STDMETHODCALLTYPE LockServer(BOOL lock) override {
    if (lock) {
      ++gModuleRefs;
    } else {
      --gModuleRefs;
    }
    return S_OK;
  }
 private:
  IUnknown* (*create_)();
};
IUnknown* CreatePreviewHandler() {
  return static_cast<IPreviewHandler*>(new (std::nothrow) PreviewHandler());
}
extern "C" BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, void*) {
  if (reason == DLL_PROCESS_ATTACH) {
    DisableThreadLibraryCalls(instance);
  }
  return TRUE;
}
extern "C" __declspec(dllexport) HRESULT __stdcall DllGetClassObject(
    REFCLSID clsid, REFIID id, void** value) {
  IUnknown* (*create)() = clsid == CLSID_VellumPreview ? CreatePreviewHandler
                         : clsid == CLSID_VellumThumbnail ? CreateThumbnailProvider
                                                         : nullptr;
  if (create == nullptr) {
    return CLASS_E_CLASSNOTAVAILABLE;
  }
  auto* factory = new (std::nothrow) ClassFactory(create);
  if (factory == nullptr) {
    return E_OUTOFMEMORY;
  }
  const HRESULT status = factory->QueryInterface(id, value);
  factory->Release();
  return status;
}
extern "C" __declspec(dllexport) HRESULT __stdcall DllCanUnloadNow() {
  return gModuleRefs == 0 ? S_OK : S_FALSE;
}
