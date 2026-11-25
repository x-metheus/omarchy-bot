// Test daemons run without an OS keychain, including on hosts with Secret Service.
Object.defineProperty(Bun, "secrets", {
  value: {
    async get() { throw new Error("No test keychain"); },
    async set() { throw new Error("No test keychain"); },
    async delete() { throw new Error("No test keychain"); },
  },
});
