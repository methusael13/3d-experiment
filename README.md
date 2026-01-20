# 3D Experiment

A WebGL-based 3D scene builder and model viewer built with vanilla JavaScript.

## Features

- **Scene Builder**: Import and position 3D models (GLB/GLTF) to create composite scenes
- **Primitive Shapes**: Add cubes, planes, and UV spheres
- **Transform Gizmos**: Translate and rotate objects with visual gizmos
- **Lighting**: Sun-based directional lighting with shadows, or HDR image-based lighting (IBL)
- **Material Editor**: Adjust PBR materials (metallic, roughness, albedo)
- **Wind System**: Animated foliage with configurable wind parameters
- **Scene Serialization**: Save and load scenes as JSON

## Prerequisites

Before you begin, ensure you have the following installed:

### Required

- **Node.js** (v18 or later) - [Download](https://nodejs.org/)

### Optional (for IBL asset generation)

- **ImageMagick** (v7+) - Required to generate HDR thumbnails

  ```bash
  # macOS
  brew install imagemagick

  # Ubuntu/Debian
  sudo apt-get install imagemagick

  # Windows
  # Download from https://imagemagick.org/script/download.php
  ```

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd 3d-experiment

# Install dependencies
npm install
```

## Development

```bash
# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Run tests
npm test
```

## IBL Asset Generation

The scene builder supports HDR environment maps for image-based lighting. To generate thumbnails for the HDR gallery:

1. Place your `.hdr` files in `public/ibl/`
2. Run the generation script:

   ```bash
   npm run generate-ibl
   ```

This will:
- Create JPG thumbnails (256x128) for each HDR file
- Generate/update `manifest.json` for the HDR gallery

## Project Structure

```
├── public/
│   └── ibl/                    # HDR environment maps
│       ├── manifest.json       # HDR gallery manifest
│       ├── *.hdr               # HDR files
│       └── *.jpg               # Generated thumbnails
├── scripts/
│   └── generate-ibl-assets.js  # IBL thumbnail generator
├── src/
│   ├── controls/               # Camera and input controls
│   ├── core/                   # Core utilities (camera, scene graph)
│   ├── demos/
│   │   ├── modelViewer/        # Simple model viewer
│   │   └── sceneBuilder/       # Full scene builder
│   └── renderers/              # WebGL renderers
└── docs/                       # Documentation
```

## License

MIT
