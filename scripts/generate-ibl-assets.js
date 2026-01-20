#!/usr/bin/env node

/**
 * Generate IBL Assets
 * 
 * Generates JPG thumbnails from HDR files and updates the manifest.json.
 * Requires ImageMagick to be installed.
 * 
 * Usage: npm run generate-ibl
 */

import { execSync, exec } from 'child_process';
import { readdirSync, writeFileSync, existsSync } from 'fs';
import { join, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');
const IBL_DIR = join(ROOT_DIR, 'public', 'ibl');

// Thumbnail dimensions (2:1 aspect ratio for equirectangular)
const THUMB_WIDTH = 256;
const THUMB_HEIGHT = 128;

// HDR to LDR exposure adjustment
const EXPOSURE = 1.5;

/**
 * Check if ImageMagick is installed
 */
function checkImageMagick() {
  try {
    execSync('magick --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert HDR to JPG thumbnail using ImageMagick
 */
function convertHdrToJpg(hdrPath, jpgPath) {
  // ImageMagick command for HDR conversion:
  // - Read HDR
  // - Apply exposure adjustment (multiply RGB channels)
  // - Resize to thumbnail dimensions
  // - Convert to JPG with quality setting
  const cmd = [
    'magick',
    `"${hdrPath}"`,
    '-evaluate', 'multiply', EXPOSURE.toString(),
    '-resize', `${THUMB_WIDTH}x${THUMB_HEIGHT}!`,
    '-quality', '85',
    `"${jpgPath}"`
  ].join(' ');
  
  execSync(cmd, { stdio: 'pipe' });
}

/**
 * Generate display name from filename
 */
function toDisplayName(name) {
  return name
    .replace(/_/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Main function
 */
async function main() {
  console.log('\n🌅 Generate IBL Assets\n');
  
  // Check ImageMagick
  if (!checkImageMagick()) {
    console.error('❌ ImageMagick not found!\n');
    console.error('This script requires ImageMagick to convert HDR files to JPG thumbnails.\n');
    console.error('Installation instructions:');
    console.error('  macOS:   brew install imagemagick');
    console.error('  Ubuntu:  sudo apt-get install imagemagick');
    console.error('  Windows: https://imagemagick.org/script/download.php\n');
    process.exit(1);
  }
  console.log('✓ ImageMagick found\n');
  
  // Check IBL directory exists
  if (!existsSync(IBL_DIR)) {
    console.error(`❌ IBL directory not found: ${IBL_DIR}`);
    console.error('Create the directory and add your .hdr files.\n');
    process.exit(1);
  }
  
  // Find all HDR files
  const files = readdirSync(IBL_DIR);
  const hdrFiles = files.filter(f => extname(f).toLowerCase() === '.hdr');
  
  if (hdrFiles.length === 0) {
    console.log('No .hdr files found in public/ibl/\n');
    process.exit(0);
  }
  
  console.log(`Found ${hdrFiles.length} HDR file(s):\n`);
  
  const manifest = { hdrs: [] };
  
  for (const hdrFile of hdrFiles) {
    const name = basename(hdrFile, '.hdr');
    const hdrPath = join(IBL_DIR, hdrFile);
    const jpgPath = join(IBL_DIR, `${name}.jpg`);
    
    try {
      convertHdrToJpg(hdrPath, jpgPath);
      console.log(`  ✓ ${hdrFile} → ${name}.jpg (${THUMB_WIDTH}x${THUMB_HEIGHT})`);
      
      manifest.hdrs.push({
        name,
        displayName: toDisplayName(name)
      });
    } catch (err) {
      console.error(`  ✗ ${hdrFile} - Failed: ${err.message}`);
    }
  }
  
  // Sort manifest alphabetically
  manifest.hdrs.sort((a, b) => a.name.localeCompare(b.name));
  
  // Write manifest
  const manifestPath = join(IBL_DIR, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\n✓ manifest.json updated with ${manifest.hdrs.length} HDR(s)\n`);
  
  console.log('Done! 🎉\n');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
