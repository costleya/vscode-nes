import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		{
			name: "vscode-test-module",
			// VS Code provides this module in its Extension Host. Let the setup
			// file supply it when running tests in Node instead.
			resolveId(id) {
				if (id === "vscode") return id;
			},
		},
	],
	resolve: {
		alias: {
			"~": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		setupFiles: ["./test/setup-vscode-mock.ts"],
		isolate: true,
	},
});
