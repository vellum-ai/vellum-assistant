#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>
namespace vellum {
enum class BundleError {
  None,
  InvalidArchive,
  UnsupportedArchive,
  Traversal,
  BoundsExceeded,
  MissingManifest,
  MalformedManifest,
  OversizedImage,
};
struct BundleMetadata {
  std::string name;
  std::string description;
  std::string version;
  std::string createdBy;
  std::string entry;
};
struct BundleResult {
  BundleError error = BundleError::None;
  BundleMetadata metadata;
  std::vector<std::uint8_t> iconPng;
  explicit operator bool() const { return error == BundleError::None; }
};
BundleResult ReadBundle(const std::uint8_t* data, std::size_t size) noexcept;
}  // namespace vellum
