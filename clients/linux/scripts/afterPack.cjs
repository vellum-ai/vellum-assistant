// afterPack.cjs — Linux-specific electron-builder post-packaging hook.
// No native post-processing is needed for the AppImage target today; this logs
// the output location so packaging runs are traceable in CI.
module.exports = async function (context) {
  console.log(`Linux packaging completed: ${context.appOutDir}`);
};
