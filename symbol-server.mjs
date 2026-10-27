// Private Metro used only for /symbolicate. It loads the target project's own
// Metro + metro.config.js read-only, adds the Expo packed-source-map readers
// in this process (`react-native start` never installs them, so the app's own
// Metro can't symbolicate), and serves on a separate port. Never touches the
// project's files or its running Metro.
//
//   node symbol-server.mjs <projectRoot> <port>

import path from 'node:path';
import { createRequire } from 'node:module';

const [, , projectRoot, port] = process.argv;
process.chdir(projectRoot);
const requireFromProject = createRequire(path.join(projectRoot, 'package.json'));

const Metro = requireFromProject('metro');
const config = await Metro.loadConfig({ cwd: projectRoot });

let patchTransformFile = null;
try {
  const { patchMetroSourceMapStringForPackedMaps } = requireFromProject('@expo/metro-config/build/serializer/sourceMap');
  ({ patchTransformFileForPackedMaps: patchTransformFile } = requireFromProject('@expo/metro-config/build/serializer/packedMap'));
  patchMetroSourceMapStringForPackedMaps();
} catch {
  // Not an Expo-transformer project: stock Metro maps already work.
}

const userEnhance = config.server.enhanceMiddleware;
const patchedConfig = {
  ...config,
  reporter: { update: () => {} },
  server: {
    ...config.server,
    port: Number(port),
    enhanceMiddleware: (middleware, server) => {
      patchTransformFile?.(server.getBundler().getBundler());
      return userEnhance ? userEnhance(middleware, server) : middleware;
    },
  },
};

await Metro.runServer(patchedConfig, { host: '127.0.0.1', port: Number(port) });
process.send?.({ ready: true });
