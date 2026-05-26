const fs = require("node:fs");
const path = require("node:path");

const workspaceRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(workspaceRoot, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const productName = String(packageJson.productName || packageJson.name || "app").trim();
const version = String(packageJson.version || "0.0.0").trim();
const sourceFileName = `${productName}-${version}-x64-portable.exe`;
const sourceFilePath = path.join(workspaceRoot, "dist", sourceFileName);
const destinationDir = path.join(workspaceRoot, "server", "public", "downloads");
const destinationFilePath = path.join(destinationDir, "Ura-Helper-windows-x64-portable.exe");

if (!fs.existsSync(sourceFilePath)) {
  throw new Error(`Build artifact not found: ${sourceFilePath}`);
}

fs.mkdirSync(destinationDir, { recursive: true });
fs.copyFileSync(sourceFilePath, destinationFilePath);

console.log(`Published ${sourceFileName} to ${destinationFilePath}`);