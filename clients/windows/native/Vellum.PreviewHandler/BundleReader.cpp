#include "BundleReader.h"
#include <algorithm>
#include <array>
#include <cstring>
#include <string_view>
#include <nlohmann/json.hpp>
#include <zlib.h>
namespace vellum {
namespace {
constexpr std::size_t kMaxBundle = 25 * 1024 * 1024;
constexpr std::size_t kMaxManifest = 64 * 1024;
constexpr std::size_t kMaxIcon = 1024 * 1024;
constexpr std::size_t kMaxFiles = 50;
std::uint16_t U16(const std::uint8_t* p) { return p[0] | (p[1] << 8); }
std::uint32_t U32(const std::uint8_t* p) {
  return static_cast<std::uint32_t>(p[0]) |
         (static_cast<std::uint32_t>(p[1]) << 8) |
         (static_cast<std::uint32_t>(p[2]) << 16) |
         (static_cast<std::uint32_t>(p[3]) << 24);
}
std::uint32_t Be32(const std::uint8_t* p) {
  return (static_cast<std::uint32_t>(p[0]) << 24) |
         (static_cast<std::uint32_t>(p[1]) << 16) |
         (static_cast<std::uint32_t>(p[2]) << 8) |
         static_cast<std::uint32_t>(p[3]);
}
bool SafePath(std::string_view path) {
  if (path.empty() || path.front() == '/' || path.front() == '\\' ||
      path.find(':') != path.npos || path.find('\0') != path.npos) {
    return false;
  }
  for (std::size_t start = 0; start <= path.size();) {
    const auto end = path.find_first_of("/\\", start);
    if (path.substr(start, end - start) == "..") {
      return false;
    }
    if (end == path.npos) {
      break;
    }
    start = end + 1;
  }
  return true;
}
struct Entry {
  std::string name;
  std::uint16_t method;
  std::uint16_t flags;
  std::uint32_t crc;
  std::uint32_t compressed;
  std::uint32_t uncompressed;
  std::uint32_t localOffset;
};
BundleResult Fail(BundleError error) {
  BundleResult result;
  result.error = error;
  return result;
}
bool Extract(const std::uint8_t* data, std::size_t size, const Entry& entry,
             std::size_t limit, std::vector<std::uint8_t>& output) {
  if (entry.uncompressed > limit || entry.localOffset > size ||
      size - entry.localOffset < 30) {
    return false;
  }
  const auto* local = data + entry.localOffset;
  const auto nameLength = U16(local + 26);
  const auto extraLength = U16(local + 28);
  const std::size_t payload = entry.localOffset + 30 + nameLength + extraLength;
  if (U32(local) != 0x04034b50 || payload > size ||
      entry.compressed > size - payload ||
      std::string_view(reinterpret_cast<const char*>(local + 30), nameLength) !=
          entry.name) {
    return false;
  }
  const auto* source = data + payload;
  output.resize(entry.uncompressed);
  if (entry.method == 0) {
    if (entry.compressed != entry.uncompressed) {
      return false;
    }
    std::memcpy(output.data(), source, output.size());
  } else {
    z_stream stream{};
    stream.next_in = const_cast<Bytef*>(source);
    stream.avail_in = entry.compressed;
    stream.next_out = output.data();
    stream.avail_out = entry.uncompressed;
    if (inflateInit2(&stream, -MAX_WBITS) != Z_OK) {
      return false;
    }
    const int status = inflate(&stream, Z_FINISH);
    inflateEnd(&stream);
    if (status != Z_STREAM_END || stream.total_in != entry.compressed ||
        stream.total_out != entry.uncompressed) {
      return false;
    }
  }
  return crc32(0, output.data(), static_cast<uInt>(output.size())) == entry.crc;
}
bool StringField(const nlohmann::json& json, const char* key,
                 std::string& output, bool required) {
  const auto item = json.find(key);
  if (item == json.end()) {
    return !required;
  }
  if (!item->is_string()) {
    return false;
  }
  output = item->get<std::string>();
  return !required || !output.empty();
}
bool ParseManifest(const std::vector<std::uint8_t>& bytes,
                   BundleMetadata& metadata) {
  const auto json = nlohmann::json::parse(bytes.begin(), bytes.end(), nullptr, false);
  if (json.is_discarded() || !json.is_object() ||
      !json.contains("format_version") || !json["format_version"].is_number_integer() ||
      json["format_version"] != 2 || !json.contains("capabilities") ||
      !json["capabilities"].is_array()) {
    return false;
  }
  std::string createdAt;
  return StringField(json, "name", metadata.name, true) &&
         StringField(json, "created_at", createdAt, true) &&
         StringField(json, "created_by", metadata.createdBy, true) &&
         StringField(json, "entry", metadata.entry, true) &&
         StringField(json, "description", metadata.description, false) &&
         StringField(json, "version", metadata.version, false) &&
         SafePath(metadata.entry);
}
BundleResult ReadBundleImpl(const std::uint8_t* data, std::size_t size) {
  if (data == nullptr || size > kMaxBundle) {
    return Fail(BundleError::BoundsExceeded);
  }
  if (size < 22) {
    return Fail(BundleError::InvalidArchive);
  }
  const std::size_t searchStart = size > 65557 ? size - 65557 : 0;
  std::size_t eocd = size - 22;
  while (eocd > searchStart && U32(data + eocd) != 0x06054b50) {
    --eocd;
  }
  if (U32(data + eocd) != 0x06054b50 || U16(data + eocd + 4) != 0 ||
      U16(data + eocd + 6) != 0 ||
      U16(data + eocd + 8) != U16(data + eocd + 10) ||
      eocd + 22 + U16(data + eocd + 20) != size) {
    return Fail(BundleError::InvalidArchive);
  }
  const std::size_t count = U16(data + eocd + 10);
  const std::size_t directorySize = U32(data + eocd + 12);
  const std::size_t directoryOffset = U32(data + eocd + 16);
  if (count == 0 || directoryOffset > eocd ||
      directorySize > eocd - directoryOffset) {
    return Fail(BundleError::BoundsExceeded);
  }
  Entry manifest{};
  Entry icon{};
  bool hasManifest = false;
  bool hasIcon = false;
  std::uint64_t expanded = 0;
  std::size_t fileCount = 0;
  std::size_t cursor = directoryOffset;
  std::vector<std::string> names;
  names.reserve(count);
  for (std::size_t i = 0; i < count; ++i) {
    if (cursor > eocd || eocd - cursor < 46 || U32(data + cursor) != 0x02014b50) {
      return Fail(BundleError::InvalidArchive);
    }
    const auto nameLength = U16(data + cursor + 28);
    const std::size_t next = cursor + 46 + nameLength + U16(data + cursor + 30) +
                             U16(data + cursor + 32);
    if (next > eocd) {
      return Fail(BundleError::InvalidArchive);
    }
    Entry entry{std::string(reinterpret_cast<const char*>(data + cursor + 46),
                            nameLength),
                U16(data + cursor + 10), U16(data + cursor + 8),
                U32(data + cursor + 16), U32(data + cursor + 20),
                U32(data + cursor + 24), U32(data + cursor + 42)};
    if (!SafePath(entry.name)) {
      return Fail(BundleError::Traversal);
    }
    if (entry.name.back() != '/' && entry.name.back() != '\\' &&
        ++fileCount > kMaxFiles) {
      return Fail(BundleError::BoundsExceeded);
    }
    if (U16(data + cursor + 34) != 0 || (entry.flags & 0x2021) != 0 ||
        (entry.method != 0 && entry.method != 8)) {
      return Fail(BundleError::UnsupportedArchive);
    }
    expanded += entry.name == "icon.png" && entry.uncompressed > kMaxIcon ? 0 : entry.uncompressed;
    if (expanded > kMaxBundle || expanded > size * 100ULL) {
      return Fail(BundleError::BoundsExceeded);
    }
    names.push_back(entry.name);
    if (entry.name == "manifest.json") {
      if (hasManifest) {
        return Fail(BundleError::InvalidArchive);
      }
      manifest = entry;
      hasManifest = true;
    } else if (entry.name == "icon.png") {
      if (hasIcon) {
        return Fail(BundleError::InvalidArchive);
      }
      icon = entry;
      hasIcon = true;
    }
    cursor = next;
  }
  if (cursor != directoryOffset + directorySize || !hasManifest) {
    return Fail(hasManifest ? BundleError::InvalidArchive
                            : BundleError::MissingManifest);
  }
  std::vector<std::uint8_t> manifestBytes;
  if (!Extract(data, size, manifest, kMaxManifest, manifestBytes)) {
    return Fail(manifest.uncompressed > kMaxManifest ? BundleError::BoundsExceeded
                                                     : BundleError::InvalidArchive);
  }
  BundleResult result;
  if (!ParseManifest(manifestBytes, result.metadata) ||
      std::find(names.begin(), names.end(), result.metadata.entry) == names.end()) {
    return Fail(BundleError::MalformedManifest);
  }
  if (!hasIcon || icon.uncompressed > kMaxIcon) {
    return result;
  }
  if (!Extract(data, size, icon, kMaxIcon, result.iconPng)) {
    return Fail(BundleError::InvalidArchive);
  }
  static constexpr std::array<std::uint8_t, 8> kPng = {
      0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a};
  if (result.iconPng.size() < 24 ||
      !std::equal(kPng.begin(), kPng.end(), result.iconPng.begin()) ||
      std::memcmp(result.iconPng.data() + 12, "IHDR", 4) != 0) {
    return Fail(BundleError::InvalidArchive);
  }
  const auto width = Be32(result.iconPng.data() + 16);
  const auto height = Be32(result.iconPng.data() + 20);
  if (width == 0 || height == 0 || width > 4096 || height > 4096 ||
      static_cast<std::uint64_t>(width) * height > 16 * 1024 * 1024) {
    return Fail(BundleError::OversizedImage);
  }
  return result;
}
}  // namespace
BundleResult ReadBundle(const std::uint8_t* data, std::size_t size) noexcept {
  try {
    return ReadBundleImpl(data, size);
  } catch (...) {
    return Fail(BundleError::InvalidArchive);
  }
}
}  // namespace vellum
