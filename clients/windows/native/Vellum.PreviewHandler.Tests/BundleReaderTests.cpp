#include "BundleReader.h"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>
namespace {
std::vector<std::uint8_t> Read(const std::filesystem::path& path) {
  std::ifstream input(path, std::ios::binary);
  return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}
bool Expect(const std::string& name, bool condition) {
  if (!condition) {
    std::cerr << "FAILED: " << name << '\n';
  }
  return condition;
}
vellum::BundleResult Parse(const std::filesystem::path& root,
                           const char* filename) {
  const auto bytes = Read(root / filename);
  return vellum::ReadBundle(bytes.data(), bytes.size());
}
}  // namespace
int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: BundleReaderTests <fixture-directory>\n";
    return 2;
  }
  const std::filesystem::path root(argv[1]);
  bool passed = true;
  const auto valid = Parse(root, "valid.vellum");
  passed &= Expect("valid bundle", static_cast<bool>(valid));
  passed &= Expect("golden name", valid.metadata.name == "Golden App");
  passed &= Expect("golden entry", valid.metadata.entry == "index.html");
  passed &= Expect("golden icon", !valid.iconPng.empty());
  passed &= Expect("oversized icon ignored", static_cast<bool>(Parse(root, "oversized-image.vellum")));
  const std::pair<const char*, vellum::BundleError> failures[] = {
      {"malformed.vellum", vellum::BundleError::InvalidArchive},
      {"traversal.vellum", vellum::BundleError::Traversal},
      {"missing-manifest.vellum", vellum::BundleError::MissingManifest},
      {"malformed-manifest.vellum", vellum::BundleError::MalformedManifest},
  };
  for (const auto& [fixture, error] : failures) {
    passed &= Expect(fixture, Parse(root, fixture).error == error);
  }
  const auto bytes = Read(root / "valid.vellum");
  for (std::size_t size = 0; size < bytes.size(); ++size) {
    const auto truncated = vellum::ReadBundle(bytes.data(), size);
    passed &= Expect("truncated archive rejected", !truncated);
  }
  if (!passed) {
    return 1;
  }
  std::cout << "BundleReader native tests passed\n";
  return 0;
}
