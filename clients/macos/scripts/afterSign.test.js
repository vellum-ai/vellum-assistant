const {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} = require("bun:test");

let findIdentityMock = mock(async () => null);

mock.module("app-builder-lib/out/codeSign/macCodeSign", () => ({
  findIdentity: (...args) => findIdentityMock(...args),
}));

const {
  __resolveSigningIdentityForTesting,
} = require("./afterSign.js");

const originalCscName = process.env.CSC_NAME;
const originalAppleSigningIdentity = process.env.APPLE_SIGNING_IDENTITY;

function makeContext({
  arch = 3,
  buildOptions = {},
  forceCodeSigning = false,
} = {}) {
  return {
    arch,
    packager: {
      platformSpecificBuildOptions: buildOptions,
      codeSigningInfo: {
        value: Promise.resolve({
          keychainFile: "/tmp/electron-builder.keychain",
        }),
      },
      forceCodeSigning,
    },
  };
}

beforeEach(() => {
  findIdentityMock = mock(async () => null);
  delete process.env.CSC_NAME;
  delete process.env.APPLE_SIGNING_IDENTITY;
});

afterEach(() => {
  if (originalCscName === undefined) {
    delete process.env.CSC_NAME;
  } else {
    process.env.CSC_NAME = originalCscName;
  }

  if (originalAppleSigningIdentity === undefined) {
    delete process.env.APPLE_SIGNING_IDENTITY;
  } else {
    process.env.APPLE_SIGNING_IDENTITY = originalAppleSigningIdentity;
  }
});

describe("resolveSigningIdentity", () => {
  test("uses electron-builder's temporary keychain for auto-discovered identities", async () => {
    findIdentityMock = mock(async (certificateType, qualifier, keychainFile) => {
      expect(certificateType).toBe("Developer ID Application");
      expect(qualifier).toBeUndefined();
      expect(keychainFile).toBe("/tmp/electron-builder.keychain");

      return {
        name: "Developer ID Application: Vellum AI, Inc. (ABCDE12345)",
        hash: "1234567890ABCDEF",
      };
    });

    await expect(
      __resolveSigningIdentityForTesting(makeContext())
    ).resolves.toEqual({
      name: "Developer ID Application: Vellum AI, Inc. (ABCDE12345)",
      sign: "1234567890ABCDEF",
      keychainFile: "/tmp/electron-builder.keychain",
    });
    expect(findIdentityMock).toHaveBeenCalledTimes(1);
  });

  test("passes APPLE_SIGNING_IDENTITY through as an explicit qualifier", async () => {
    process.env.APPLE_SIGNING_IDENTITY = "Developer ID Application: Vellum";
    findIdentityMock = mock(async (_certificateType, qualifier) => {
      expect(qualifier).toBe("Developer ID Application: Vellum");

      return {
        name: "Developer ID Application: Vellum",
        hash: "ABCDEF1234567890",
      };
    });

    await expect(
      __resolveSigningIdentityForTesting(makeContext())
    ).resolves.toMatchObject({
      name: "Developer ID Application: Vellum",
      sign: "ABCDEF1234567890",
    });
  });

  test("keeps electron-builder's arm64 ad-hoc fallback when no identity exists", async () => {
    await expect(
      __resolveSigningIdentityForTesting(makeContext({ arch: 3 }))
    ).resolves.toEqual({
      name: "-",
      sign: "-",
      keychainFile: "/tmp/electron-builder.keychain",
    });
  });
});
