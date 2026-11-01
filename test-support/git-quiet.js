// Loaded before every test file (see the "test" script). Git fixtures commit into temporary repositories, and
// Git may start automatic maintenance or gc in the background, creating and removing .git/objects/maintenance.lock
// while a test walks the directory for a strict snapshot. Disabling both here covers every git the tests start,
// including the ones the code under test runs, without touching the user's own Git configuration.
const settings = [['maintenance.auto', 'false'], ['gc.auto', '0']];
const count = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
settings.forEach(([key, value], index) => {
  process.env[`GIT_CONFIG_KEY_${count + index}`] = key;
  process.env[`GIT_CONFIG_VALUE_${count + index}`] = value;
});
process.env.GIT_CONFIG_COUNT = String(count + settings.length);
