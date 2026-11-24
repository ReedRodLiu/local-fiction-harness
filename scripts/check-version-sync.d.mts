export function extractAndroidVersionName(gradleText: string): string | null;
export function verifyVersionSync(rootDir?: string): {
  packageVersion: string;
  androidVersionName: string;
};
