const fs = require("node:fs");
const path = require("node:path");

const workspaceRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(workspaceRoot, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const productName = String(packageJson.productName || packageJson.name || "app").trim();
const version = String(packageJson.version || "0.0.0").trim();
const distDir = path.join(workspaceRoot, "dist");
const destinationDir = path.join(workspaceRoot, "server", "public", "downloads");
const requestedPlatforms = new Set(
  process.argv.slice(2).flatMap((arg) => {
    if (arg === "--win" || arg === "win") {
      return ["win"];
    }

    if (arg === "--mac" || arg === "mac") {
      return ["mac"];
    }

    return [];
  })
);

const artifacts = [
  {
    platform: "win",
    sourceFileName: `${productName}-${version}-x64-portable.exe`,
    destinationFileName: "Ura-Helper-windows-x64-portable.exe"
  },
  {
    platform: "mac",
    sourceFileName: `${productName}-${version}-mac-arm64.dmg`,
    destinationFileName: "Ura-Helper-macos-arm64.dmg"
  },
  {
    platform: "mac",
    sourceFileName: `${productName}-${version}-mac-arm64.zip`,
    destinationFileName: "Ura-Helper-macos-arm64.zip"
  }
];

const artifactsToPublish = artifacts.filter((artifact) => {
  if (requestedPlatforms.size === 0) {
    return true;
  }

  return requestedPlatforms.has(artifact.platform);
});

const missingRequestedArtifacts = [];
const publishedArtifacts = [];

fs.mkdirSync(destinationDir, { recursive: true });

for (const artifact of artifactsToPublish) {
  const sourceFilePath = path.join(distDir, artifact.sourceFileName);
  const destinationFilePath = path.join(destinationDir, artifact.destinationFileName);

  if (!fs.existsSync(sourceFilePath)) {
    if (requestedPlatforms.size > 0) {
      missingRequestedArtifacts.push(sourceFilePath);
    }

    continue;
  }

  fs.copyFileSync(sourceFilePath, destinationFilePath);
  publishedArtifacts.push({
    sourceFileName: artifact.sourceFileName,
    destinationFilePath
  });
}

if (missingRequestedArtifacts.length > 0) {
  throw new Error(`Build artifacts not found:\n${missingRequestedArtifacts.join("\n")}`);
}

if (publishedArtifacts.length === 0) {
  throw new Error(`No build artifacts found in ${distDir}`);
}

for (const artifact of publishedArtifacts) {
  console.log(`Published ${artifact.sourceFileName} to ${artifact.destinationFilePath}`);
}