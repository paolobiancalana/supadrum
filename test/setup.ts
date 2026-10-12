// The operator's shell exports SUPADRUM_CONFIG for the live runner; a test
// that spawns the CLI with process.env would otherwise write to that config.
delete process.env.SUPADRUM_CONFIG;
