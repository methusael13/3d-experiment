# WebGPU Rendering Architecture

This document provides a comprehensive overview of the WebGPU rendering flow in the 3D experiment project.

## High-Level Architecture Overview

```mermaid
flowchart TB
    subgraph UI["UI Layer (Preact)"]
        App[SceneBuilderApp]
        MenuBar[MenuBarBridge]
        ObjectsPanel[ObjectsPanelBridge]
        ObjectPanel[ObjectPanelBridge]
        TerrainPanel[TerrainPanelBridge]
        WaterPanel[WaterPanelBridge]
        RenderingPanel[RenderingPanelBridge]
        Store[SceneBuilderStore]
    end

    subgraph Core["Core Engine"]
        Viewport[Viewport]
        Scene[Scene]
        AnimLoop[AnimationLoop]
    end

    subgraph SceneObjects["Scene Objects"]
        GPUTerrainObj[GPUTerrainSceneObject]
        OceanObj[OceanSceneObject]
        ModelObj[ModelObject]
        PrimitiveObj[PrimitiveObject]
        LightObj[DirectionalLight]
    end

    subgraph Managers["Domain Managers"]
        TerrainMgr[TerrainManager]
        OceanMgr[OceanManager]
    end

    subgraph Pipeline["GPU Pipeline"]
        ForwardPipeline[GPUForwardPipeline]
        RenderContext[RenderContext]
    end

    App --> Store
    Store --> Scene
    Store --> Viewport
    
    MenuBar --> Scene
    ObjectsPanel --> Scene
    TerrainPanel --> TerrainMgr
    WaterPanel --> OceanMgr
    
    Viewport --> ForwardPipeline
    Viewport --> AnimLoop
    AnimLoop --> ForwardPipeline
    
    Scene --> GPUTerrainObj
    Scene --> OceanObj
    Scene --> ModelObj
    Scene --> PrimitiveObj
    Scene --> LightObj
    
    GPUTerrainObj --> TerrainMgr
    OceanObj --> OceanMgr
    
    ForwardPipeline --> RenderContext
```

## Render Pass Execution Flow

```mermaid
flowchart TD
    subgraph ForwardPipeline["GPUForwardPipeline.render()"]
        Start([Frame Start])
        CreateContext[Create RenderContext]
        
        subgraph Passes["Render Passes (Priority Order)"]
            SkyPass[1. SkyPass<br/>Priority: 100]
            ShadowPass[2. ShadowPass<br/>Priority: 200]
            OpaquePass[3. OpaquePass<br/>Priority: 300]
            TransparentPass[4. TransparentPass<br/>Priority: 400]
            OverlayPass[5. OverlayPass<br/>Priority: 500]
            DebugPass[6. DebugPass<br/>Priority: 600]
        end
        
        PostProcess[PostProcessPipeline]
        End([Frame End])
    end

    Start --> CreateContext
    CreateContext --> SkyPass
    SkyPass --> ShadowPass
    ShadowPass --> OpaquePass
    OpaquePass --> TransparentPass
    TransparentPass --> OverlayPass
    OverlayPass --> DebugPass
    DebugPass --> PostProcess
    PostProcess --> End
```

## Detailed Component Flow

```mermaid
flowchart TB
    subgraph Viewport["Viewport Class"]
        VP_Init[initialize]
        VP_Render[renderFrame]
        VP_Resize[handleResize]
    end

    subgraph GPUContext["GPUContext"]
        Device[GPUDevice]
        Queue[GPUQueue]
        Canvas[Canvas Context]
    end

    subgraph ForwardPipeline["GPUForwardPipeline"]
        FP_Init[initialize]
        FP_Render[render]
        FP_SetScene[setScene]
        
        subgraph Renderers["GPU Renderers"]
            SkyRenderer[SkyRendererGPU]
            ObjectRenderer[ObjectRendererGPU]
            GridRenderer[GridRendererGPU]
            ShadowRenderer[ShadowRendererGPU]
        end
        
        subgraph RenderPasses["Render Passes"]
            RP_Sky[SkyPass]
            RP_Shadow[ShadowPass]
            RP_Opaque[OpaquePass]
            RP_Transparent[TransparentPass]
            RP_Overlay[OverlayPass]
            RP_Debug[DebugPass]
        end
    end

    subgraph PostProcess["PostProcessPipeline"]
        PP_Init[initialize]
        PP_Execute[execute]
        SSAO[SSAOEffect]
        Composite[CompositeEffect]
    end

    VP_Init --> GPUContext
    VP_Init --> FP_Init
    VP_Init --> PP_Init
    
    VP_Render --> FP_Render
    FP_Render --> RP_Sky
    FP_Render --> RP_Shadow
    FP_Render --> RP_Opaque
    FP_Render --> RP_Transparent
    FP_Render --> RP_Overlay
    FP_Render --> RP_Debug
    FP_Render --> PP_Execute
    
    RP_Sky --> SkyRenderer
    RP_Opaque --> ObjectRenderer
    RP_Shadow --> ShadowRenderer
    RP_Overlay --> GridRenderer
```

## Scene Object Hierarchy

```mermaid
classDiagram
    class Scene {
        -objects: Map~string, SceneObject~
        -gpuTerrainObject: GPUTerrainSceneObject
        -oceanObject: OceanSceneObject
        +addSceneObject()
        +removeObject()
        +getWebGPUTerrain()
        +getOcean()
    }

    class SceneObject {
        +id: string
        +name: string
        +position: vec3
        +rotation: vec3
        +scale: vec3
        +objectType: string
        +getModelMatrix()
    }

    class GPUTerrainSceneObject {
        -terrainManager: TerrainManager
        +setTerrainManager()
        +getTerrainManager()
        +getBoundingBox()
    }

    class OceanSceneObject {
        -oceanManager: OceanManager
        +setOceanManager()
        +getOceanManager()
        +getBoundingBox()
    }

    class ModelObject {
        +modelPath: string
        +meshes: Mesh[]
    }

    class PrimitiveObject {
        +primitiveType: string
        +primitiveConfig: PrimitiveConfig
    }

    Scene --> SceneObject
    SceneObject <|-- GPUTerrainSceneObject
    SceneObject <|-- OceanSceneObject
    SceneObject <|-- ModelObject
    SceneObject <|-- PrimitiveObject
```

## Manager Pattern (Terrain & Ocean)

```mermaid
flowchart TB
    subgraph TerrainSystem["Terrain System"]
        TerrainSceneObj[GPUTerrainSceneObject<br/>Lightweight proxy]
        TerrainManager[TerrainManager<br/>Heavy orchestrator]
        
        subgraph TerrainComponents["TerrainManager Components"]
            HeightmapGen[HeightmapGenerator]
            ErosionSim[ErosionSimulator]
            CDLODRenderer[CDLODRendererGPU]
            MipmapGen[HeightmapMipmapGenerator]
        end
    end

    subgraph OceanSystem["Ocean System"]
        OceanSceneObj[OceanSceneObject<br/>Lightweight proxy]
        OceanManager[OceanManager<br/>Heavy orchestrator]
        
        subgraph OceanComponents["OceanManager Components"]
            WaterRenderer[WaterRendererGPU]
            WaterConfig[WaterConfig]
        end
    end

    TerrainSceneObj --> TerrainManager
    TerrainManager --> HeightmapGen
    TerrainManager --> ErosionSim
    TerrainManager --> CDLODRenderer
    TerrainManager --> MipmapGen

    OceanSceneObj --> OceanManager
    OceanManager --> WaterRenderer
    OceanManager --> WaterConfig
```

## Render Context Data Flow

```mermaid
flowchart LR
    subgraph Input["Input Data"]
        Scene[Scene]
        Camera[Camera Position/Forward]
        Options[Render Options]
        Time[Frame Time]
    end

    subgraph RenderContext["RenderContext"]
        Encoder[GPUCommandEncoder]
        ViewProj[viewProjectionMatrix]
        CamPos[cameraPosition]
        LightDir[lightDirection]
        Textures[Color/Depth Textures]
        
        Methods["Methods:<br/>getColorAttachment()<br/>getDepthAttachment()<br/>copyDepthForReading()"]
    end

    subgraph Passes["Render Passes"]
        Pass1[SkyPass]
        Pass2[OpaquePass]
        Pass3[TransparentPass]
    end

    Scene --> RenderContext
    Camera --> RenderContext
    Options --> RenderContext
    Time --> RenderContext
    
    RenderContext --> Pass1
    RenderContext --> Pass2
    RenderContext --> Pass3
```

## Pass Dependencies & Data Access

```mermaid
flowchart TB
    subgraph RenderContext["RenderContext (ctx)"]
        CTX_Scene[ctx.scene]
        CTX_Options[ctx.options]
        CTX_Encoder[ctx.encoder]
        CTX_Textures[ctx.colorTexture<br/>ctx.depthTexture]
    end

    subgraph SkyPass["SkyPass"]
        Sky_Render["skyRenderer.renderSunSky()<br/>skyRenderer.renderHDRSky()"]
    end

    subgraph ShadowPass["ShadowPass"]
        Shadow_Terrain["scene.getWebGPUTerrain()<br/>.getTerrainManager()"]
        Shadow_Render["shadowRenderer.renderShadowMap()"]
    end

    subgraph OpaquePass["OpaquePass"]
        Opaque_Terrain["scene.getWebGPUTerrain()<br/>.getTerrainManager()"]
        Opaque_TerrainRender["terrainManager.render()"]
        Opaque_ObjectRender["objectRenderer.render()"]
    end

    subgraph TransparentPass["TransparentPass"]
        Trans_Ocean["scene.getOcean()<br/>.getOceanManager()"]
        Trans_Terrain["scene.getWebGPUTerrain()<br/>.getTerrainManager()"]
        Trans_Render["oceanManager.render()"]
    end

    subgraph OverlayPass["OverlayPass"]
        Overlay_Render["gridRenderer.render()"]
    end

    CTX_Scene --> Shadow_Terrain
    CTX_Scene --> Opaque_Terrain
    CTX_Scene --> Trans_Ocean
    CTX_Scene --> Trans_Terrain
    
    CTX_Options --> Sky_Render
    CTX_Encoder --> Shadow_Render
    CTX_Encoder --> Opaque_TerrainRender
    CTX_Encoder --> Trans_Render
    CTX_Encoder --> Overlay_Render
```

## Post-Processing Pipeline

```mermaid
flowchart TB
    subgraph HDRPath["HDR Rendering Path"]
        HDR_Color[HDR Color Buffer<br/>rgba16float]
        HDR_Depth[Depth Buffer<br/>depth24plus]
    end

    subgraph PostProcess["PostProcessPipeline"]
        PP_SSAO[SSAOEffect<br/>Screen-Space AO]
        PP_Composite[CompositeEffect<br/>Tone Mapping + Gamma]
        
        subgraph Buffers["Buffer Pool"]
            Temp1[Temp Buffer 1]
            Temp2[Temp Buffer 2]
        end
    end

    subgraph Output["Final Output"]
        SwapChain[Swap Chain<br/>bgra8unorm]
    end

    HDR_Color --> PP_SSAO
    HDR_Depth --> PP_SSAO
    PP_SSAO --> PP_Composite
    PP_Composite --> SwapChain
    
    PP_SSAO <--> Buffers
    PP_Composite <--> Buffers
```

## UI ↔ Core Communication

```mermaid
sequenceDiagram
    participant UI as Panel/Bridge
    participant Store as SceneBuilderStore
    participant Scene as Scene
    participant Manager as Manager (Terrain/Ocean)
    participant Renderer as GPU Renderer

    Note over UI,Renderer: Configuration Change Flow
    UI->>Store: onChange(params)
    Store->>Scene: getWebGPUTerrain() / getOcean()
    Scene-->>Store: SceneObject
    Store->>Manager: setConfig(params)
    Manager->>Renderer: setConfig(params)
    
    Note over UI,Renderer: Render Frame Flow  
    loop Animation Frame
        Store->>Scene: getAllObjects()
        Scene-->>Store: objects[]
        Store->>Manager: render(passEncoder, params)
        Manager->>Renderer: render(passEncoder, params)
    end
```

## GPU Resource Hierarchy

```mermaid
flowchart TB
    subgraph GPUContext["GPUContext"]
        Device[GPUDevice]
        Queue[GPUQueue]
    end

    subgraph Wrappers["Unified Wrappers"]
        UnifiedBuffer[UnifiedGPUBuffer<br/>Vertex/Index/Uniform/Storage]
        UnifiedTexture[UnifiedGPUTexture<br/>2D/Depth/Cube]
        ShaderModule[GPUShaderModule]
        BindGroup[GPUBindGroup]
        RenderPipelineWrapper[RenderPipelineWrapper]
    end

    subgraph Builders["Builder Pattern"]
        BindGroupLayoutBuilder[BindGroupLayoutBuilder]
        BindGroupBuilder[BindGroupBuilder]
        UniformBuilder[UniformBuilder]
    end

    Device --> UnifiedBuffer
    Device --> UnifiedTexture
    Device --> ShaderModule
    Device --> BindGroup
    Device --> RenderPipelineWrapper
    
    BindGroupLayoutBuilder --> BindGroup
    BindGroupBuilder --> BindGroup
    UniformBuilder --> UnifiedBuffer
```

## File Organization

```
src/
├── core/
│   ├── Scene.ts                    # Scene management, object registry
│   ├── gpu/
│   │   ├── GPUContext.ts          # WebGPU device/queue management
│   │   ├── GPUBuffer.ts           # UnifiedGPUBuffer wrapper
│   │   ├── GPUTexture.ts          # UnifiedGPUTexture wrapper
│   │   ├── GPUBindGroup.ts        # Bind group builders
│   │   ├── GPURenderPipeline.ts   # RenderPipelineWrapper
│   │   ├── pipeline/
│   │   │   ├── GPUForwardPipeline.ts  # Main render orchestrator
│   │   │   ├── RenderContext.ts       # Per-frame render state
│   │   │   ├── RenderPass.ts          # Base pass class
│   │   │   └── passes/
│   │   │       └── index.ts           # Sky/Shadow/Opaque/Transparent/Overlay/Debug
│   │   ├── renderers/
│   │   │   ├── SkyRendererGPU.ts
│   │   │   ├── ObjectRendererGPU.ts
│   │   │   ├── GridRendererGPU.ts
│   │   │   ├── ShadowRendererGPU.ts
│   │   │   └── WaterRendererGPU.ts
│   │   ├── postprocess/
│   │   │   ├── PostProcessPipeline.ts
│   │   │   └── effects/
│   │   └── shaders/
│   │       ├── *.wgsl
│   │       └── terrain/*.wgsl
│   ├── sceneObjects/
│   │   ├── SceneObject.ts         # Base class
│   │   ├── GPUTerrainSceneObject.ts
│   │   ├── OceanSceneObject.ts
│   │   ├── ModelObject.ts
│   │   └── PrimitiveObject.ts
│   ├── terrain/
│   │   ├── TerrainManager.ts      # Terrain orchestrator
│   │   ├── CDLODRendererGPU.ts
│   │   ├── HeightmapGenerator.ts
│   │   └── ErosionSimulator.ts
│   └── ocean/
│       ├── OceanManager.ts        # Ocean orchestrator
│       └── index.ts
└── demos/sceneBuilder/
    ├── Viewport.ts                # Main application viewport
    ├── components/
    │   ├── bridges/               # Preact ↔ Core adapters
    │   ├── panels/                # UI panels
    │   └── state/
    │       └── SceneBuilderStore.ts
    └── ...
```

## Key Design Patterns

### 1. Manager Pattern (Terrain/Ocean)
- **Scene Object**: Lightweight proxy in scene graph for selection/raycasting
- **Manager**: Heavy orchestrator owning GPU resources and rendering logic
- **Benefit**: Separation of scene membership from rendering concerns

### 2. Render Pass Pattern
- **BaseRenderPass**: Abstract interface with `execute(ctx: RenderContext)`
- **Priority System**: Passes sorted by priority for correct ordering
- **RenderContext**: Shared per-frame state passed to all passes

### 3. Builder Pattern (GPU Resources)
- `UniformBuilder`: Fluent API for uniform buffer construction
- `BindGroupLayoutBuilder`: Declarative bind group layout creation
- `BindGroupBuilder`: Type-safe bind group creation

### 4. Bridge Pattern (UI)
- **Panel Components**: Pure Preact components (no core dependencies)
- **Bridge Components**: Connect panels to SceneBuilderStore and managers
- **Store**: Central state management with signals
