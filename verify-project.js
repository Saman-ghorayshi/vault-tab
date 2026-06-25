const fs = require('fs');
const path = require('path');

const projectRoot = __dirname;
let hasErrors = false;

console.log('🔍 Starting Aegis Tab Project Verification...\n');

// Helper function to log errors
function logError(message) {
    console.log(`❌ ERROR: ${message}`);
    hasErrors = true;
}

// Helper function to log success
function logSuccess(message) {
    console.log(`✅ OK: ${message}`);
}

// 1. Check if manifest.json exists and is valid
const manifestPath = path.join(projectRoot, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
    logError('manifest.json is missing from the root directory!');
} else {
    try {
        const manifestContent = fs.readFileSync(manifestPath, 'utf8');
        const manifest = JSON.parse(manifestContent);
        logSuccess('manifest.json found and is valid JSON.');

        // 2. Check if the popup file declared in manifest exists
        if (manifest.action && manifest.action.default_popup) {
            const popupPath = path.join(projectRoot, manifest.action.default_popup);
            if (!fs.existsSync(popupPath)) {
                logError(`Manifest declares default_popup as "${manifest.action.default_popup}", but that file does not exist!`);
            } else {
                logSuccess(`Popup file found at: ${manifest.action.default_popup}`);
            }
        }
    } catch (e) {
        logError('manifest.json contains invalid JSON syntax.');
    }
}

// 3. Find all JavaScript files in the project
function getAllJsFiles(dir, fileList = []) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        // Skip node_modules or git folders if they exist
        if (file === '.git' || file === 'node_modules') continue;
        
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) {
            getAllJsFiles(filePath, fileList);
        } else if (file.endsWith('.js')) {
            fileList.push(filePath);
        }
    }
    return fileList;
}

const jsFiles = getAllJsFiles(projectRoot);
console.log(`\n📂 Found ${jsFiles.length} JavaScript files. Checking internal imports...`);

// 4. Scan each JS file for import statements and verify the paths
const importRegex = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;

jsFiles.forEach(jsFilePath => {
    const content = fs.readFileSync(jsFilePath, 'utf8');
    let match;
    const fileName = path.relative(projectRoot, jsFilePath);
    
    while ((match = importRegex.exec(content)) !== null) {
        const importPath = match[1];
        
        // Only check relative local imports (starts with . or ..)
        if (importPath.startsWith('.')) {
            // Calculate what the absolute path should be
            const targetPath = path.resolve(path.dirname(jsFilePath), importPath);
            
            if (!fs.existsSync(targetPath)) {
                logError(`Broken import in ${fileName} -> Cannot find "${importPath}"`);
            }
        }
    }
});

// Final Output
console.log('\n======================================');
if (hasErrors) {
    console.log('🚨 VERIFICATION FAILED: Please fix the errors above before loading into Chrome.');
    process.exit(1);
} else {
    console.log('🎉 VERIFICATION PASSED: All files and internal links are perfectly connected!');
    process.exit(0);
}