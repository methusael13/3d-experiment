# 3D Experiment

A WebGL2/WebGPU-based 3D scene builder with procedural terrain generation, PBR rendering, and real-time water simulation.

## Features

### Rendering
- **Dual Rendering Backend**: WebGL2 (stable) and WebGPU (modern, higher performance)
- **PBR Materials**: Physically-based rendering with metallic/roughness workflow
- **Dynamic IBL**: Real-time image-based lighting from procedural sky
- **Shadow Mapping**: Cascaded shadow maps with soft shadows
- **Post-Processing**: SSAO, tonemapping (ACES/Reinhard), and compositing
- **HDR Environment Maps**: Load and render with HDR skyboxes

### Scene Builder
- **3D Model Import**: GLB/GLTF, OBJ file support with drag-and-drop
- **Primitive Shapes**: Cubes, planes, UV spheres
- **Transform Gizmos**: Translate, rotate, scale with local/world orientation
- **Uniform Scale**: Interactive uniform scaling with 'S' key
- **Multi-Selection**: Shift+click for additive selection
- **Grouping**: Ctrl+G to group, Ctrl+Shift+G to ungroup

### Terrain System
- **Procedural Generation**: Multi-octave noise with customizable parameters
- **CDLOD Rendering**: Continuous Distance-Dependent Level of Detail
- **GPU Culling**: Frustum culling computed on GPU
- **Erosion Simulation**: Hydraulic and thermal erosion
- **Material Layers**: Height and slope-based texture blending
- **Island Mask**: Configurable landmass boundaries

### Water/Ocean
- **Gerstner Waves**: Multi-octave wave simulation
- **Reflections & Refractions**: Screen-space water effects
- **Foam**: Shore foam and wave crest foam
- **Depth-Based Color**: Shallow to deep water color gradient

### Environment
- **Procedural Sky**: Physically-based atmospheric scattering
- **Sun Lighting**: Adjustable elevation, azimuth, and intensity
- **Wind System**: Animated vegetation with turbulence

### Camera
- **Orbit Camera**: Standard 3D editor camera
- **FPS Camera**: First-person exploration mode (F key)
- **View Presets**: Quick views (0-3 keys)

## Prerequisites

### Required
- **Node.js** (v18 or later) - [Download](https://nodejs.org/)
- **Modern Browser**: Chrome 113+, Edge 113+, or Firefox 121+ for WebGPU

### Optional (for IBL asset generation)
- **ImageMagick** (v7+) - Required to generate HDR thumbnails
  ```bash
  # macOS
  brew install imagemagick
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
# Start development server (frontend only)
npm run dev

# Start asset library server (required for Asset Library panel)
npm run dev:server

# Build for production
npm run build

# Preview production build
npm run preview

# Run tests
npm test
```

## Asset Library Server

The Asset Library Server indexes and serves assets from the `public/` folder, providing a browsable library with thumbnail previews.

### Running the Asset Server

```bash
# Start the asset server (port 3002)
npm run dev:server
```

### Populating the Asset Library

Before running the asset server, populate the `public/` folder with your assets:

```
public/
├── models/
│   ├── terrain/
│   │   └── vegetation/       # Vegetation models (GLTF/GLB)
│   │       └── ribbon_grass_xxx/
│   │           ├── standard/
│   │           │   └── xxx_nonUE.gltf
│   │           ├── Textures/
│   │           │   └── T_xxx_4K_B.png
│   │           └── xxx.json  # Metadata manifest
│   └── props/                # General 3D models
├── textures/
│   ├── atlas/
│   │   └── vegetation/       # Texture atlases
│   └── terrain/              # Terrain textures
└── ibl/                      # HDR environment maps
```

### Supported Asset Sources

| Source | URL | Asset Types |
|--------|-----|-------------|
| **Quixel Megascans** | [quixel.com](https://quixel.com/megascans) | Vegetation, surfaces, props |
| **Poly Haven** | [polyhaven.com](https://polyhaven.com) | HDRIs, textures |
| **Sketchfab** | [sketchfab.com](https://sketchfab.com) | 3D models (GLB/GLTF) |
| **cgtrader** | [cgtrader.com](https://cgtrader.com) | Premium assets |

### Asset Formats

| Format | Extension | Use Case |
|--------|-----------|----------|
| GLTF/GLB | `.gltf`, `.glb` | 3D models with materials |
| PNG/JPG | `.png`, `.jpg` | Textures |
| HDR/EXR | `.hdr`, `.exr` | Environment maps |
| JSON | `.json` | Asset metadata manifests |

### Quixel Megascans Setup

1. Download assets from [Quixel Bridge](https://quixel.com/bridge)
2. Export as **Standard** format (not Unreal Engine format)
3. Place in `public/models/terrain/vegetation/` or appropriate folder
4. The indexer will detect and parse the `manifest.json` or `*.json` metadata

### Asset Server API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/assets` | GET | List all assets (with query filters) |
| `/api/assets/:id` | GET | Get asset details with files |
| `/api/previews/:id.webp` | GET | Get thumbnail preview |
| `/api/stats` | GET | Database statistics |

**Query Parameters:**
- `?type=vegetation` - Filter by asset type
- `?category=model` - Filter by category
- `?search=grass` - Full-text search

### Clearing the Asset Database

To re-index all assets from scratch:

```bash
rm -rf .asset-server/
npm run server
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| T | Translate mode |
| R | Rotate mode |
| S | Uniform scale mode |
| F | Toggle FPS camera |
| A | Select all / deselect all |
| D | Duplicate selected |
| Delete | Delete selected |
| Ctrl+G | Group selection |
| Ctrl+Shift+G | Ungroup |
| 0-3 | Camera presets |

## Project Structure

```
├── public/
│   └── ibl/                      # HDR environment maps
├── src/
│   ├── core/
│   │   ├── gpu/                  # WebGPU rendering system
│   │   │   ├── pipeline/         # Forward rendering pipeline
│   │   │   ├── postprocess/      # Post-processing effects
│   │   │   ├── renderers/        # Object, terrain, water renderers
│   │   │   ├── shaders/          # WGSL shaders
│   │   │   └── ibl/              # Image-based lighting
│   │   ├── terrain/              # Terrain generation & rendering
│   │   ├── ocean/                # Water simulation
│   │   ├── sceneObjects/         # Scene object types
│   │   └── renderers/            # WebGL2 renderers (legacy)
│   ├── demos/
│   │   └── sceneBuilder/         # Main application
│   │       ├── components/       # Preact UI components
│   │       ├── gizmos/           # Transform gizmos
│   │       └── ...
│   └── loaders/                  # Asset loaders
└── docs/                         # Architecture documentation
```

## Technology Stack

- **TypeScript** - Type-safe development
- **Vite** - Build tooling and dev server
- **Preact** - Lightweight UI framework with signals
- **gl-matrix** - High-performance matrix/vector math
- **WebGPU/WebGL2** - Graphics APIs
- **WGSL** - WebGPU Shading Language

## Browser Support

| Browser | WebGL2 | WebGPU |
|---------|--------|--------|
| Chrome 113+ | ✅ | ✅ |
| Edge 113+ | ✅ | ✅ |
| Firefox 121+ | ✅ | ✅ (flag) |
| Safari 17+ | ✅ | ⚠️ (partial) |

## Documentation

- [WebGPU Migration Plan](docs/webgpu-migration-plan.md)
- [WebGPU Rendering Architecture](docs/webgpu-rendering-architecture.md)
- [CDLOD Terrain System](docs/cdlod-plan.md)
- [Preact Migration Plan](docs/preact-migration-plan.md)

## License

MIT
