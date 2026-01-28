# Game Engine Architecture Guide

A comprehensive guide for building a cross-platform C++ game engine with multi-backend graphics, Lua scripting, and Dear ImGui tooling. Primary target: macOS (Apple Silicon + Intel).

---

## Table of Contents

1. [Overall Engine Architecture](#1-overall-engine-architecture)
2. [Graphics Abstraction Design Patterns](#2-graphics-abstraction-design-patterns)
3. [ImGui + MoltenVK Integration](#3-imgui--moltenvk-integration)
4. [Lua Scripting Architecture](#4-lua-scripting-architecture)
5. [Build System Setup (CMake + vcpkg)](#5-build-system-setup-cmake--vcpkg)
6. [IDE Setup and Development Workflow](#6-ide-setup-and-development-workflow)
7. [Appendix: Recommended Libraries](#appendix-recommended-libraries)

---

## 1. Overall Engine Architecture

### High-Level Module Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              APPLICATION LAYER                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │    Game     │  │   Editor    │  │  Launcher   │  │   Asset Processor   │ │
│  │  Runtime    │  │  (ImGui)    │  │             │  │   (Offline Tool)    │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────────┘ │
├─────────────────────────────────────────────────────────────────────────────┤
│                              ENGINE LAYER                                    │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                         SCRIPTING (Lua + sol2)                         │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │    Scene     │  │   Physics    │  │    Audio     │  │   Animation    │  │
│  │   Manager    │  │   (Jolt)     │  │ (miniaudio)  │  │    System      │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │     ECS      │  │   Assets     │  │     UI       │  │   Networking   │  │
│  │   (EnTT)     │  │   Manager    │  │   System     │  │   (optional)   │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └────────────────┘  │
├─────────────────────────────────────────────────────────────────────────────┤
│                              CORE LAYER                                      │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                    RENDER HARDWARE INTERFACE (RHI)                     │ │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────────┐   │ │
│  │  │   OpenGL   │  │   Vulkan   │  │   Metal    │  │    WebGPU      │   │ │
│  │  │  Backend   │  │  Backend   │  │  Backend   │  │   (future)     │   │ │
│  │  └────────────┘  └────────────┘  └────────────┘  └────────────────┘   │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │   Platform   │  │    Math      │  │   Memory     │  │     Job        │  │
│  │  Abstraction │  │   (GLM)      │  │   System     │  │    System      │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │   Logging    │  │  Profiling   │  │   Events     │  │   File I/O     │  │
│  │   System     │  │   System     │  │   System     │  │   (VFS)        │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └────────────────┘  │
├─────────────────────────────────────────────────────────────────────────────┤
│                              PLATFORM LAYER                                  │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                      WINDOW & INPUT (SDL3 / GLFW)                      │ │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────────┐   │ │
│  │  │   macOS    │  │  Windows   │  │   Linux    │  │      Web       │   │ │
│  │  └────────────┘  └────────────┘  └────────────┘  └────────────────┘   │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Directory Structure

```
engine/
├── CMakeLists.txt              # Root CMake
├── vcpkg.json                  # Package manifest
├── .clang-format               # Code style
├── .clangd                     # LSP config
│
├── engine/                     # Core engine library
│   ├── CMakeLists.txt
│   ├── include/engine/         # Public headers
│   │   ├── core/
│   │   │   ├── Application.hpp
│   │   │   ├── Logger.hpp
│   │   │   ├── Memory.hpp
│   │   │   └── Types.hpp
│   │   ├── rhi/                # Render Hardware Interface
│   │   │   ├── RHI.hpp
│   │   │   ├── Buffer.hpp
│   │   │   ├── Texture.hpp
│   │   │   ├── Shader.hpp
│   │   │   ├── Pipeline.hpp
│   │   │   └── CommandBuffer.hpp
│   │   ├── scene/
│   │   ├── scripting/
│   │   └── ...
│   │
│   └── src/                    # Private implementation
│       ├── core/
│       ├── rhi/
│       │   ├── opengl/
│       │   ├── vulkan/
│       │   └── metal/
│       ├── scene/
│       └── ...
│
├── editor/                     # Editor application (ImGui)
│   ├── CMakeLists.txt
│   ├── include/
│   └── src/
│       ├── main.cpp
│       ├── EditorApp.cpp
│       ├── panels/
│       │   ├── SceneHierarchy.cpp
│       │   ├── Inspector.cpp
│       │   ├── AssetBrowser.cpp
│       │   └── Viewport.cpp
│       └── ...
│
├── runtime/                    # Game runtime executable
│   ├── CMakeLists.txt
│   └── src/
│       └── main.cpp
│
├── tools/                      # Offline tools
│   ├── asset_processor/
│   └── shader_compiler/
│
├── scripts/                    # Lua game scripts
│   ├── main.lua
│   └── entities/
│
├── assets/                     # Raw assets
│   ├── shaders/
│   │   ├── common/
│   │   ├── opengl/
│   │   ├── vulkan/
│   │   └── metal/
│   ├── models/
│   ├── textures/
│   └── ...
│
└── third_party/                # Vendored dependencies (if not using vcpkg)
    └── ...
```

### Main Loop Architecture

```cpp
// engine/include/engine/core/Application.hpp

namespace Engine {

class Application {
public:
    virtual ~Application() = default;
    
    void run();
    
protected:
    virtual void onInit() {}
    virtual void onShutdown() {}
    virtual void onUpdate(float deltaTime) {}
    virtual void onFixedUpdate(float fixedDeltaTime) {}
    virtual void onRender() {}
    virtual void onImGuiRender() {}
    
private:
    void mainLoop();
    
    std::unique_ptr<Window> m_window;
    std::unique_ptr<RHI::Device> m_renderDevice;
    std::unique_ptr<ScriptEngine> m_scriptEngine;
    std::unique_ptr<Scene> m_activeScene;
    
    bool m_running = true;
    double m_lastFrameTime = 0.0;
    double m_accumulator = 0.0;
    static constexpr double FIXED_TIMESTEP = 1.0 / 60.0;
};

} // namespace Engine
```

```cpp
// engine/src/core/Application.cpp

void Application::run() {
    // Initialize subsystems
    Logger::init();
    m_window = Window::create({"My Engine", 1920, 1080});
    m_renderDevice = RHI::Device::create(RHI::Backend::Vulkan);
    m_scriptEngine = std::make_unique<ScriptEngine>();
    
    onInit();
    
    m_lastFrameTime = m_window->getTime();
    
    while (m_running && !m_window->shouldClose()) {
        mainLoop();
    }
    
    onShutdown();
}

void Application::mainLoop() {
    // Calculate delta time
    double currentTime = m_window->getTime();
    double deltaTime = currentTime - m_lastFrameTime;
    m_lastFrameTime = currentTime;
    
    // Cap delta time to prevent spiral of death
    if (deltaTime > 0.25) deltaTime = 0.25;
    
    // Poll input events
    m_window->pollEvents();
    
    // Fixed timestep updates (physics, networking)
    m_accumulator += deltaTime;
    while (m_accumulator >= FIXED_TIMESTEP) {
        onFixedUpdate(static_cast<float>(FIXED_TIMESTEP));
        m_accumulator -= FIXED_TIMESTEP;
    }
    
    // Variable timestep update (game logic, animation)
    onUpdate(static_cast<float>(deltaTime));
    
    // Render
    m_renderDevice->beginFrame();
    onRender();
    
    // ImGui overlay (editor only)
    ImGui_ImplVulkan_NewFrame();
    ImGui_ImplSDL3_NewFrame();
    ImGui::NewFrame();
    onImGuiRender();
    ImGui::Render();
    
    m_renderDevice->endFrame();
    m_renderDevice->present();
}
```

---

## 2. Graphics Abstraction Design Patterns

### Design Philosophy

The Render Hardware Interface (RHI) provides a **thin abstraction** over graphics APIs. Goals:

1. **Minimal overhead** - No virtual calls in hot paths
2. **Explicit resource management** - No hidden allocations
3. **Command buffer based** - Deferred execution for multi-threading
4. **Backend agnostic** - Same API for OpenGL, Vulkan, Metal

### Core Types

```cpp
// engine/include/engine/rhi/Types.hpp

namespace Engine::RHI {

// Opaque handles - internally just indices or pointers
struct BufferHandle { uint32_t id = UINT32_MAX; bool isValid() const { return id != UINT32_MAX; } };
struct TextureHandle { uint32_t id = UINT32_MAX; bool isValid() const { return id != UINT32_MAX; } };
struct ShaderHandle { uint32_t id = UINT32_MAX; bool isValid() const { return id != UINT32_MAX; } };
struct PipelineHandle { uint32_t id = UINT32_MAX; bool isValid() const { return id != UINT32_MAX; } };
struct RenderPassHandle { uint32_t id = UINT32_MAX; bool isValid() const { return id != UINT32_MAX; } };

enum class Backend {
    OpenGL,
    Vulkan,
    Metal,
    Auto  // Platform default
};

enum class BufferUsage : uint32_t {
    Vertex   = 1 << 0,
    Index    = 1 << 1,
    Uniform  = 1 << 2,
    Storage  = 1 << 3,
    Indirect = 1 << 4,
    Transfer = 1 << 5,
};

enum class TextureFormat {
    R8, RG8, RGBA8, RGBA8_SRGB,
    R16F, RG16F, RGBA16F,
    R32F, RG32F, RGBA32F,
    Depth16, Depth24, Depth32F,
    Depth24Stencil8, Depth32FStencil8,
    BC1, BC3, BC5, BC7,  // Compressed
};

enum class TextureUsage : uint32_t {
    Sampled      = 1 << 0,
    Storage      = 1 << 1,
    RenderTarget = 1 << 2,
    DepthStencil = 1 << 3,
    TransferSrc  = 1 << 4,
    TransferDst  = 1 << 5,
};

enum class ShaderStage : uint32_t {
    Vertex   = 1 << 0,
    Fragment = 1 << 1,
    Compute  = 1 << 2,
    Geometry = 1 << 3,  // Avoid on Mac
};

struct BufferDesc {
    uint64_t size = 0;
    BufferUsage usage = BufferUsage::Vertex;
    bool cpuVisible = false;
    const void* initialData = nullptr;
    const char* debugName = nullptr;
};

struct TextureDesc {
    uint32_t width = 1;
    uint32_t height = 1;
    uint32_t depth = 1;
    uint32_t mipLevels = 1;
    uint32_t arrayLayers = 1;
    TextureFormat format = TextureFormat::RGBA8;
    TextureUsage usage = TextureUsage::Sampled;
    bool isCubemap = false;
    const char* debugName = nullptr;
};

struct ShaderDesc {
    std::span<const uint8_t> vertexSpirv;
    std::span<const uint8_t> fragmentSpirv;
    std::span<const uint8_t> computeSpirv;  // For compute shaders
    const char* debugName = nullptr;
};

} // namespace Engine::RHI
```

### Device Interface

```cpp
// engine/include/engine/rhi/Device.hpp

namespace Engine::RHI {

class Device {
public:
    virtual ~Device() = default;
    
    // Factory - creates platform-appropriate backend
    static std::unique_ptr<Device> create(Backend backend = Backend::Auto);
    
    // Resource creation
    virtual BufferHandle createBuffer(const BufferDesc& desc) = 0;
    virtual void destroyBuffer(BufferHandle handle) = 0;
    virtual void* mapBuffer(BufferHandle handle) = 0;
    virtual void unmapBuffer(BufferHandle handle) = 0;
    virtual void updateBuffer(BufferHandle handle, const void* data, uint64_t size, uint64_t offset = 0) = 0;
    
    virtual TextureHandle createTexture(const TextureDesc& desc) = 0;
    virtual void destroyTexture(TextureHandle handle) = 0;
    virtual void updateTexture(TextureHandle handle, const void* data, uint32_t mipLevel = 0, uint32_t arrayLayer = 0) = 0;
    
    virtual ShaderHandle createShader(const ShaderDesc& desc) = 0;
    virtual void destroyShader(ShaderHandle handle) = 0;
    
    virtual PipelineHandle createGraphicsPipeline(const GraphicsPipelineDesc& desc) = 0;
    virtual PipelineHandle createComputePipeline(const ComputePipelineDesc& desc) = 0;
    virtual void destroyPipeline(PipelineHandle handle) = 0;
    
    // Per-frame operations
    virtual void beginFrame() = 0;
    virtual void endFrame() = 0;
    virtual void present() = 0;
    
    // Command buffer submission
    virtual CommandBuffer* getCommandBuffer() = 0;
    virtual void submitCommandBuffer(CommandBuffer* cmd) = 0;
    
    // Utilities
    virtual Backend getBackend() const = 0;
    virtual const char* getDeviceName() const = 0;
};

} // namespace Engine::RHI
```

### Command Buffer (Stateless Recording)

```cpp
// engine/include/engine/rhi/CommandBuffer.hpp

namespace Engine::RHI {

class CommandBuffer {
public:
    virtual ~CommandBuffer() = default;
    
    // Render pass
    virtual void beginRenderPass(const RenderPassBeginInfo& info) = 0;
    virtual void endRenderPass() = 0;
    
    // State
    virtual void bindPipeline(PipelineHandle pipeline) = 0;
    virtual void bindVertexBuffer(BufferHandle buffer, uint32_t binding = 0, uint64_t offset = 0) = 0;
    virtual void bindIndexBuffer(BufferHandle buffer, IndexType type, uint64_t offset = 0) = 0;
    virtual void bindUniformBuffer(BufferHandle buffer, uint32_t set, uint32_t binding) = 0;
    virtual void bindTexture(TextureHandle texture, uint32_t set, uint32_t binding) = 0;
    
    // Dynamic state
    virtual void setViewport(float x, float y, float width, float height, float minDepth = 0.0f, float maxDepth = 1.0f) = 0;
    virtual void setScissor(int32_t x, int32_t y, uint32_t width, uint32_t height) = 0;
    
    // Draw
    virtual void draw(uint32_t vertexCount, uint32_t instanceCount = 1, uint32_t firstVertex = 0, uint32_t firstInstance = 0) = 0;
    virtual void drawIndexed(uint32_t indexCount, uint32_t instanceCount = 1, uint32_t firstIndex = 0, int32_t vertexOffset = 0, uint32_t firstInstance = 0) = 0;
    virtual void drawIndirect(BufferHandle buffer, uint64_t offset, uint32_t drawCount, uint32_t stride) = 0;
    
    // Compute
    virtual void dispatch(uint32_t groupCountX, uint32_t groupCountY, uint32_t groupCountZ) = 0;
    
    // Barriers & sync
    virtual void pipelineBarrier(const BarrierInfo& info) = 0;
    
    // Copy
    virtual void copyBuffer(BufferHandle src, BufferHandle dst, uint64_t size, uint64_t srcOffset = 0, uint64_t dstOffset = 0) = 0;
    virtual void copyBufferToTexture(BufferHandle src, TextureHandle dst, const BufferTextureCopyInfo& info) = 0;
};

} // namespace Engine::RHI
```

### Backend Implementation Example (Vulkan)

```cpp
// engine/src/rhi/vulkan/VulkanDevice.cpp

namespace Engine::RHI {

class VulkanDevice : public Device {
public:
    VulkanDevice(Window* window);
    ~VulkanDevice() override;
    
    BufferHandle createBuffer(const BufferDesc& desc) override {
        VkBufferCreateInfo bufferInfo{};
        bufferInfo.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
        bufferInfo.size = desc.size;
        bufferInfo.usage = translateBufferUsage(desc.usage);
        bufferInfo.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
        
        VmaAllocationCreateInfo allocInfo{};
        allocInfo.usage = desc.cpuVisible ? VMA_MEMORY_USAGE_CPU_TO_GPU : VMA_MEMORY_USAGE_GPU_ONLY;
        
        VulkanBuffer buffer;
        vmaCreateBuffer(m_allocator, &bufferInfo, &allocInfo, &buffer.handle, &buffer.allocation, nullptr);
        
        if (desc.initialData) {
            void* mapped;
            vmaMapMemory(m_allocator, buffer.allocation, &mapped);
            memcpy(mapped, desc.initialData, desc.size);
            vmaUnmapMemory(m_allocator, buffer.allocation);
        }
        
        uint32_t id = m_buffers.size();
        m_buffers.push_back(buffer);
        return BufferHandle{id};
    }
    
private:
    VkInstance m_instance;
    VkDevice m_device;
    VkPhysicalDevice m_physicalDevice;
    VmaAllocator m_allocator;
    VkSwapchainKHR m_swapchain;
    
    std::vector<VulkanBuffer> m_buffers;
    std::vector<VulkanTexture> m_textures;
    std::vector<VulkanShader> m_shaders;
    std::vector<VulkanPipeline> m_pipelines;
};

// Factory implementation
std::unique_ptr<Device> Device::create(Backend backend) {
    if (backend == Backend::Auto) {
        #if defined(__APPLE__)
            backend = Backend::Vulkan;  // MoltenVK
        #elif defined(_WIN32)
            backend = Backend::Vulkan;
        #else
            backend = Backend::OpenGL;
        #endif
    }
    
    switch (backend) {
        case Backend::Vulkan: return std::make_unique<VulkanDevice>();
        case Backend::OpenGL: return std::make_unique<OpenGLDevice>();
        case Backend::Metal:  return std::make_unique<MetalDevice>();
        default: throw std::runtime_error("Unknown backend");
    }
}

} // namespace Engine::RHI
```

### Shader Cross-Compilation Strategy

```
GLSL Source (.glsl)
       │
       ▼
┌─────────────────┐
│   glslangValidator  │  → SPIR-V (intermediate)
└─────────────────┘
       │
       ├─────────────────────┬────────────────────┐
       ▼                     ▼                    ▼
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│ SPIRV-Cross │      │ SPIRV-Cross │      │    Direct   │
│   → GLSL    │      │   → MSL     │      │   SPIR-V    │
└─────────────┘      └─────────────┘      └─────────────┘
       │                     │                    │
       ▼                     ▼                    ▼
   OpenGL              Metal              Vulkan
```

```cpp
// tools/shader_compiler/main.cpp

// Compile shaders at build time
int main(int argc, char** argv) {
    // 1. Read GLSL source
    std::string vertSrc = readFile("shaders/pbr.vert");
    std::string fragSrc = readFile("shaders/pbr.frag");
    
    // 2. Compile to SPIR-V with glslang
    std::vector<uint32_t> vertSpirv = compileGLSL(vertSrc, ShaderStage::Vertex);
    std::vector<uint32_t> fragSpirv = compileGLSL(fragSrc, ShaderStage::Fragment);
    
    // 3. Generate backend-specific shaders with SPIRV-Cross
    spirv_cross::CompilerGLSL glslCompiler(vertSpirv);
    spirv_cross::CompilerMSL mslCompiler(vertSpirv);
    
    // 4. Output compiled shaders
    writeFile("compiled/pbr.vert.spv", vertSpirv);
    writeFile("compiled/pbr.vert.glsl", glslCompiler.compile());
    writeFile("compiled/pbr.vert.metal", mslCompiler.compile());
    
    return 0;
}
```

---

## 3. ImGui + MoltenVK Integration

### Overview

Dear ImGui + Vulkan (via MoltenVK on macOS) provides excellent performance and integrates well with the RHI abstraction. ImGui provides official backends for both.

### Dependencies

```json
// vcpkg.json
{
  "dependencies": [
    "imgui",
    "imgui[vulkan-binding]",
    "imgui[sdl3-binding]",
    "vulkan",
    "vulkan-memory-allocator"
  ]
}
```

### MoltenVK Setup (macOS)

MoltenVK is a Vulkan implementation that translates to Metal. Two installation options:

**Option A: Vulkan SDK (Recommended)**
```bash
# Download from https://vulkan.lunarg.com/sdk/home
# Installs to /usr/local/share/vulkan/

# Set environment variables (add to ~/.zshrc)
export VULKAN_SDK="/usr/local/share/vulkan"
export VK_ICD_FILENAMES="$VULKAN_SDK/icd.d/MoltenVK_icd.json"
export VK_LAYER_PATH="$VULKAN_SDK/explicit_layer.d"
```

**Option B: vcpkg**
```bash
vcpkg install moltenvk
```

### ImGui Initialization

```cpp
// editor/src/ImGuiLayer.cpp

#include <imgui.h>
#include <imgui_impl_sdl3.h>
#include <imgui_impl_vulkan.h>

class ImGuiLayer {
public:
    void init(SDL_Window* window, VkInstance instance, VkDevice device, 
              VkPhysicalDevice physicalDevice, VkQueue graphicsQueue, 
              uint32_t graphicsQueueFamily, VkRenderPass renderPass) {
        
        // Create descriptor pool for ImGui
        VkDescriptorPoolSize poolSizes[] = {
            { VK_DESCRIPTOR_TYPE_SAMPLER, 1000 },
            { VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1000 },
            { VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE, 1000 },
            { VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 1000 },
            { VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, 1000 },
            { VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER, 1000 },
            { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1000 },
            { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1000 },
            { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, 1000 },
            { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC, 1000 },
            { VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT, 1000 }
        };
        
        VkDescriptorPoolCreateInfo poolInfo{};
        poolInfo.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO;
        poolInfo.flags = VK_DESCRIPTOR_POOL_CREATE_FREE_DESCRIPTOR_SET_BIT;
        poolInfo.maxSets = 1000;
        poolInfo.poolSizeCount = std::size(poolSizes);
        poolInfo.pPoolSizes = poolSizes;
        vkCreateDescriptorPool(device, &poolInfo, nullptr, &m_descriptorPool);
        
        // Initialize ImGui
        IMGUI_CHECKVERSION();
        ImGui::CreateContext();
        ImGuiIO& io = ImGui::GetIO();
        io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
        io.ConfigFlags |= ImGuiConfigFlags_DockingEnable;
        io.ConfigFlags |= ImGuiConfigFlags_ViewportsEnable;  // Multi-viewport
        
        // Style
        ImGui::StyleColorsDark();
        ImGuiStyle& style = ImGui::GetStyle();
        if (io.ConfigFlags & ImGuiConfigFlags_ViewportsEnable) {
            style.WindowRounding = 0.0f;
            style.Colors[ImGuiCol_WindowBg].w = 1.0f;
        }
        
        // Platform/Renderer bindings
        ImGui_ImplSDL3_InitForVulkan(window);
        
        ImGui_ImplVulkan_InitInfo initInfo{};
        initInfo.Instance = instance;
        initInfo.PhysicalDevice = physicalDevice;
        initInfo.Device = device;
        initInfo.QueueFamily = graphicsQueueFamily;
        initInfo.Queue = graphicsQueue;
        initInfo.DescriptorPool = m_descriptorPool;
        initInfo.MinImageCount = 2;
        initInfo.ImageCount = 2;
        initInfo.MSAASamples = VK_SAMPLE_COUNT_1_BIT;
        
        ImGui_ImplVulkan_Init(&initInfo, renderPass);
        
        // Upload fonts
        VkCommandBuffer cmd = beginSingleTimeCommands();
        ImGui_ImplVulkan_CreateFontsTexture(cmd);
        endSingleTimeCommands(cmd);
        ImGui_ImplVulkan_DestroyFontUploadObjects();
    }
    
    void beginFrame() {
        ImGui_ImplVulkan_NewFrame();
        ImGui_ImplSDL3_NewFrame();
        ImGui::NewFrame();
    }
    
    void endFrame(VkCommandBuffer cmd) {
        ImGui::Render();
        ImGui_ImplVulkan_RenderDrawData(ImGui::GetDrawData(), cmd);
        
        // Handle multi-viewport
        ImGuiIO& io = ImGui::GetIO();
        if (io.ConfigFlags & ImGuiConfigFlags_ViewportsEnable) {
            ImGui::UpdatePlatformWindows();
            ImGui::RenderPlatformWindowsDefault();
        }
    }
    
    void shutdown() {
        ImGui_ImplVulkan_Shutdown();
        ImGui_ImplSDL3_Shutdown();
        ImGui::DestroyContext();
        vkDestroyDescriptorPool(m_device, m_descriptorPool, nullptr);
    }
    
private:
    VkDevice m_device;
    VkDescriptorPool m_descriptorPool;
};
```

### Rendering ImGui to a Viewport Texture

For editor viewports, render the scene to an offscreen texture, then display it in ImGui:

```cpp
// editor/src/panels/Viewport.cpp

class ViewportPanel {
public:
    void render(RHI::Device* device, Scene* scene) {
        ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0, 0));
        ImGui::Begin("Viewport");
        
        // Get available size
        ImVec2 viewportSize = ImGui::GetContentRegionAvail();
        
        // Resize framebuffer if needed
        if (m_viewportSize.x != viewportSize.x || m_viewportSize.y != viewportSize.y) {
            m_viewportSize = viewportSize;
            recreateFramebuffer(device, (uint32_t)viewportSize.x, (uint32_t)viewportSize.y);
        }
        
        // Render scene to offscreen texture
        renderSceneToTexture(device, scene);
        
        // Display texture in ImGui
        ImGui::Image(
            (ImTextureID)m_viewportDescriptor,  // Vulkan descriptor set
            viewportSize,
            ImVec2(0, 1),  // UV flipped for Vulkan
            ImVec2(1, 0)
        );
        
        // Handle gizmos, picking, etc.
        if (ImGui::IsWindowHovered()) {
            handleInput();
        }
        
        ImGui::End();
        ImGui::PopStyleVar();
    }
    
private:
    ImVec2 m_viewportSize{0, 0};
    RHI::TextureHandle m_colorTexture;
    RHI::TextureHandle m_depthTexture;
    VkDescriptorSet m_viewportDescriptor;  // For ImGui::Image
    
    void recreateFramebuffer(RHI::Device* device, uint32_t width, uint32_t height) {
        // Destroy old textures
        if (m_colorTexture.isValid()) {
            device->destroyTexture(m_colorTexture);
            device->destroyTexture(m_depthTexture);
        }
        
        // Create new render targets
        m_colorTexture = device->createTexture({
            .width = width,
            .height = height,
            .format = RHI::TextureFormat::RGBA8,
            .usage = RHI::TextureUsage::RenderTarget | RHI::TextureUsage::Sampled,
            .debugName = "Viewport Color"
        });
        
        m_depthTexture = device->createTexture({
            .width = width,
            .height = height,
            .format = RHI::TextureFormat::Depth32F,
            .usage = RHI::TextureUsage::DepthStencil,
            .debugName = "Viewport Depth"
        });
        
        // Create ImGui texture descriptor
        m_viewportDescriptor = ImGui_ImplVulkan_AddTexture(
            m_sampler, 
            m_colorTextureView, 
            VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL
        );
    }
};
```

---

## 4. Lua Scripting Architecture

### Design Goals

1. **Hot-reload** - Modify scripts without restarting
2. **Safe sandboxing** - Scripts can't crash the engine
3. **Native performance** - Hot paths stay in C++
4. **Ergonomic API** - Clean Lua syntax for game logic

### sol2 Integration

[sol2](https://github.com/ThePhD/sol2) is a modern C++17 Lua binding library. Header-only, fast, and safe.

```cpp
// engine/include/engine/scripting/ScriptEngine.hpp

#include <sol/sol.hpp>

namespace Engine {

class ScriptEngine {
public:
    ScriptEngine();
    ~ScriptEngine();
    
    // Core API
    void init();
    void shutdown();
    void update(float deltaTime);
    
    // Script loading
    void loadScript(const std::string& path);
    void reloadScripts();
    
    // Expose C++ to Lua
    template<typename T>
    void registerType(const std::string& name);
    
    void registerFunction(const std::string& name, sol::function func);
    
    // Call Lua from C++
    template<typename Ret, typename... Args>
    Ret call(const std::string& funcName, Args&&... args);
    
    sol::state& getLua() { return m_lua; }
    
private:
    sol::state m_lua;
    std::vector<std::string> m_loadedScripts;
    
    void setupSandbox();
    void registerCoreAPI();
    void registerMathAPI();
    void registerECSAPI();
    void registerInputAPI();
};

} // namespace Engine
```

### Exposing Engine Types to Lua

```cpp
// engine/src/scripting/ScriptEngine.cpp

void ScriptEngine::init() {
    // Open standard libraries (sandboxed)
    m_lua.open_libraries(
        sol::lib::base,
        sol::lib::math,
        sol::lib::string,
        sol::lib::table,
        sol::lib::coroutine
    );
    
    // Disable dangerous functions
    setupSandbox();
    
    // Register engine API
    registerCoreAPI();
    registerMathAPI();
    registerECSAPI();
    registerInputAPI();
}

void ScriptEngine::setupSandbox() {
    // Remove dangerous functions
    m_lua["os"] = sol::nil;
    m_lua["io"] = sol::nil;
    m_lua["dofile"] = sol::nil;
    m_lua["loadfile"] = sol::nil;
    m_lua["load"] = sol::nil;  // Can be re-enabled with restrictions
}

void ScriptEngine::registerMathAPI() {
    // vec3
    auto vec3_type = m_lua.new_usertype<glm::vec3>("vec3",
        sol::constructors<
            glm::vec3(),
            glm::vec3(float),
            glm::vec3(float, float, float)
        >(),
        "x", &glm::vec3::x,
        "y", &glm::vec3::y,
        "z", &glm::vec3::z,
        sol::meta_function::addition, [](const glm::vec3& a, const glm::vec3& b) { return a + b; },
        sol::meta_function::subtraction, [](const glm::vec3& a, const glm::vec3& b) { return a - b; },
        sol::meta_function::multiplication, sol::overload(
            [](const glm::vec3& v, float s) { return v * s; },
            [](float s, const glm::vec3& v) { return s * v; }
        ),
        "length", [](const glm::vec3& v) { return glm::length(v); },
        "normalize", [](const glm::vec3& v) { return glm::normalize(v); },
        "dot", [](const glm::vec3& a, const glm::vec3& b) { return glm::dot(a, b); },
        "cross", [](const glm::vec3& a, const glm::vec3& b) { return glm::cross(a, b); }
    );
    
    // quat
    auto quat_type = m_lua.new_usertype<glm::quat>("quat",
        sol::constructors<
            glm::quat(),
            glm::quat(float, float, float, float)
        >(),
        "x", &glm::quat::x,
        "y", &glm::quat::y,
        "z", &glm::quat::z,
        "w", &glm::quat::w,
        sol::meta_function::multiplication, [](const glm::quat& q, const glm::vec3& v) { return q * v; },
        "euler", [](float pitch, float yaw, float roll) { 
            return glm::quat(glm::vec3(pitch, yaw, roll)); 
        },
        "lookAt", [](const glm::vec3& forward, const glm::vec3& up) {
            return glm::quatLookAt(forward, up);
        }
    );
}

void ScriptEngine::registerECSAPI() {
    // Entity
    auto entity_type = m_lua.new_usertype<Entity>("Entity",
        sol::no_constructor,  // Created by Scene
        "id", sol::readonly(&Entity::id),
        "valid", &Entity::isValid,
        "destroy", &Entity::destroy
    );
    
    // Transform component
    auto transform_type = m_lua.new_usertype<TransformComponent>("Transform",
        sol::no_constructor,
        "position", &TransformComponent::position,
        "rotation", &TransformComponent::rotation,
        "scale", &TransformComponent::scale,
        "forward", &TransformComponent::getForward,
        "right", &TransformComponent::getRight,
        "up", &TransformComponent::getUp,
        "lookAt", &TransformComponent::lookAt,
        "translate", &TransformComponent::translate,
        "rotate", &TransformComponent::rotate
    );
    
    // Scene
    auto scene_type = m_lua.new_usertype<Scene>("Scene",
        sol::no_constructor,
        "createEntity", &Scene::createEntity,
        "destroyEntity", &Scene::destroyEntity,
        "findEntity", &Scene::findEntityByName,
        "getTransform", &Scene::getComponent<TransformComponent>,
        "getMeshRenderer", &Scene::getComponent<MeshRendererComponent>,
        "getRigidBody", &Scene::getComponent<RigidBodyComponent>
    );
    
    // Expose current scene
    m_lua["Scene"] = m_lua.create_table_with(
        "current", [this]() { return Application::get().getActiveScene(); }
    );
}

void ScriptEngine::registerInputAPI() {
    m_lua["Input"] = m_lua.create_table_with(
        "isKeyDown", &Input::isKeyDown,
        "isKeyPressed", &Input::isKeyPressed,
        "isKeyReleased", &Input::isKeyReleased,
        "isMouseButtonDown", &Input::isMouseButtonDown,
        "getMousePosition", &Input::getMousePosition,
        "getMouseDelta", &Input::getMouseDelta,
        "getAxis", &Input::getAxis  // For gamepad/virtual axes
    );
    
    // Key codes
    m_lua["Key"] = m_lua.create_table_with(
        "W", Key::W, "A", Key::A, "S", Key::S, "D", Key::D,
        "Space", Key::Space, "Shift", Key::LeftShift,
        "Escape", Key::Escape
        // ... etc
    );
}
```

### Example Lua Script

```lua
-- scripts/player.lua

local Player = {}
Player.__index = Player

function Player.new(entity)
    local self = setmetatable({}, Player)
    self.entity = entity
    self.transform = Scene.current():getTransform(entity)
    self.speed = 5.0
    self.jumpForce = 10.0
    self.isGrounded = false
    return self
end

function Player:update(dt)
    -- Movement
    local moveDir = vec3(0, 0, 0)
    
    if Input.isKeyDown(Key.W) then moveDir.z = moveDir.z - 1 end
    if Input.isKeyDown(Key.S) then moveDir.z = moveDir.z + 1 end
    if Input.isKeyDown(Key.A) then moveDir.x = moveDir.x - 1 end
    if Input.isKeyDown(Key.D) then moveDir.x = moveDir.x + 1 end
    
    if moveDir:length() > 0 then
        moveDir = moveDir:normalize()
        local forward = self.transform:forward()
        local right = self.transform:right()
        
        local worldDir = forward * moveDir.z + right * moveDir.x
        self.transform:translate(worldDir * self.speed * dt)
    end
    
    -- Jump
    if self.isGrounded and Input.isKeyPressed(Key.Space) then
        local rb = Scene.current():getRigidBody(self.entity)
        if rb then
            rb:addImpulse(vec3(0, self.jumpForce, 0))
        end
    end
    
    -- Look
    local mouseDelta = Input.getMouseDelta()
    if mouseDelta:length() > 0 then
        self.transform:rotate(vec3(-mouseDelta.y * 0.002, -mouseDelta.x * 0.002, 0))
    end
end

return Player
```

### Hot-Reloading

```cpp
void ScriptEngine::reloadScripts() {
    LOG_INFO("Reloading scripts...");
    
    // Clear current script state (but keep registered types)
    m_lua.collect_garbage();
    
    // Reload all scripts
    for (const auto& path : m_loadedScripts) {
        try {
            m_lua.script_file(path);
            LOG_INFO("Reloaded: {}", path);
        } catch (const sol::error& e) {
            LOG_ERROR("Script error in {}: {}", path, e.what());
        }
    }
    
    // Call onReload hook if defined
    if (m_lua["onReload"].valid()) {
        m_lua["onReload"]();
    }
}

// In editor, watch for file changes
void EditorApp::onUpdate(float dt) {
    if (m_fileWatcher.hasChanges("scripts/")) {
        m_scriptEngine->reloadScripts();
    }
}
```

---

## 5. Build System Setup (CMake + vcpkg)

### vcpkg Setup

```bash
# Clone vcpkg
git clone https://github.com/microsoft/vcpkg.git
cd vcpkg && ./bootstrap-vcpkg.sh

# Set environment variable (add to ~/.zshrc)
export VCPKG_ROOT="$HOME/vcpkg"
export PATH="$VCPKG_ROOT:$PATH"
```

### vcpkg.json (Manifest Mode)

```json
{
  "$schema": "https://raw.githubusercontent.com/microsoft/vcpkg-tool/main/docs/vcpkg.schema.json",
  "name": "my-engine",
  "version": "0.1.0",
  "dependencies": [
    "glm",
    "glfw3",
    "sdl3",
    "vulkan",
    "vulkan-memory-allocator",
    "imgui",
    {
      "name": "imgui",
      "features": ["vulkan-binding", "sdl3-binding", "docking-experimental"]
    },
    "spdlog",
    "nlohmann-json",
    "entt",
    "lua",
    "sol2",
    "stb",
    "tinygltf",
    "spirv-cross",
    "glslang",
    "joltphysics",
    "miniaudio"
  ],
  "overrides": [
    { "name": "imgui", "version": "1.90.1" }
  ]
}
```

### Root CMakeLists.txt

```cmake
cmake_minimum_required(VERSION 3.25)

# Use vcpkg toolchain
if(DEFINED ENV{VCPKG_ROOT})
    set(CMAKE_TOOLCHAIN_FILE "$ENV{VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake" CACHE STRING "")
endif()

project(MyEngine VERSION 0.1.0 LANGUAGES CXX)

# C++20
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Output directories
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/lib)
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/lib)

# Options
option(ENGINE_BUILD_EDITOR "Build the editor application" ON)
option(ENGINE_BUILD_TESTS "Build unit tests" ON)
option(ENGINE_ENABLE_VULKAN "Enable Vulkan backend" ON)
option(ENGINE_ENABLE_METAL "Enable Metal backend (macOS only)" ${APPLE})
option(ENGINE_ENABLE_OPENGL "Enable OpenGL backend" ON)

# Find packages
find_package(Vulkan REQUIRED)
find_package(glm CONFIG REQUIRED)
find_package(glfw3 CONFIG REQUIRED)
find_package(SDL3 CONFIG REQUIRED)
find_package(imgui CONFIG REQUIRED)
find_package(spdlog CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)
find_package(EnTT CONFIG REQUIRED)
find_package(lua CONFIG REQUIRED)
find_package(sol2 CONFIG REQUIRED)
find_package(Stb REQUIRED)
find_package(unofficial-spirv-cross CONFIG REQUIRED)
find_package(unofficial-vulkan-memory-allocator CONFIG REQUIRED)

# Subdirectories
add_subdirectory(engine)
add_subdirectory(runtime)

if(ENGINE_BUILD_EDITOR)
    add_subdirectory(editor)
endif()

if(ENGINE_BUILD_TESTS)
    enable_testing()
    add_subdirectory(tests)
endif()

add_subdirectory(tools)
```

### Engine Library CMakeLists.txt

```cmake
# engine/CMakeLists.txt

set(ENGINE_SOURCES
    src/core/Application.cpp
    src/core/Logger.cpp
    src/core/Window.cpp
    
    src/rhi/Device.cpp
    src/rhi/opengl/OpenGLDevice.cpp
    src/rhi/vulkan/VulkanDevice.cpp
    src/rhi/vulkan/VulkanCommandBuffer.cpp
    
    src/scene/Scene.cpp
    src/scene/Entity.cpp
    src/scene/Components.cpp
    
    src/scripting/ScriptEngine.cpp
    
    src/assets/AssetManager.cpp
    src/assets/TextureLoader.cpp
    src/assets/ModelLoader.cpp
)

set(ENGINE_HEADERS
    include/engine/Engine.hpp
    include/engine/core/Application.hpp
    include/engine/core/Logger.hpp
    include/engine/core/Types.hpp
    include/engine/rhi/RHI.hpp
    include/engine/rhi/Device.hpp
    include/engine/rhi/Buffer.hpp
    include/engine/rhi/Texture.hpp
    include/engine/scene/Scene.hpp
    include/engine/scene/Entity.hpp
    include/engine/scripting/ScriptEngine.hpp
)

# Metal backend (macOS only)
if(APPLE AND ENGINE_ENABLE_METAL)
    list(APPEND ENGINE_SOURCES
        src/rhi/metal/MetalDevice.mm
        src/rhi/metal/MetalCommandBuffer.mm
    )
endif()

add_library(Engine STATIC ${ENGINE_SOURCES} ${ENGINE_HEADERS})

target_include_directories(Engine
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_link_libraries(Engine
    PUBLIC
        glm::glm
        EnTT::EnTT
        spdlog::spdlog
    PRIVATE
        Vulkan::Vulkan
        unofficial::vulkan-memory-allocator::vulkan-memory-allocator
        SDL3::SDL3
        imgui::imgui
        sol2
        lua::lua
        unofficial::spirv-cross::spirv-cross-core
        unofficial::spirv-cross::spirv-cross-glsl
        unofficial::spirv-cross::spirv-cross-msl
)

# Platform-specific
if(APPLE)
    target_link_libraries(Engine PRIVATE
        "-framework Metal"
        "-framework MetalKit"
        "-framework Cocoa"
        "-framework QuartzCore"
    )
endif()

target_compile_definitions(Engine
    PUBLIC
        $<$<BOOL:${ENGINE_ENABLE_VULKAN}>:ENGINE_VULKAN>
        $<$<BOOL:${ENGINE_ENABLE_METAL}>:ENGINE_METAL>
        $<$<BOOL:${ENGINE_ENABLE_OPENGL}>:ENGINE_OPENGL>
)

# Precompiled header
target_precompile_headers(Engine PRIVATE
    <string>
    <vector>
    <memory>
    <unordered_map>
    <functional>
    <glm/glm.hpp>
    <spdlog/spdlog.h>
)
```

### CMake Presets

```json
// CMakePresets.json
{
  "version": 6,
  "configurePresets": [
    {
      "name": "base",
      "hidden": true,
      "generator": "Ninja Multi-Config",
      "binaryDir": "${sourceDir}/build",
      "cacheVariables": {
        "CMAKE_EXPORT_COMPILE_COMMANDS": "ON"
      }
    },
    {
      "name": "macos",
      "inherits": "base",
      "displayName": "macOS (Vulkan + Metal)",
      "cacheVariables": {
        "ENGINE_ENABLE_VULKAN": "ON",
        "ENGINE_ENABLE_METAL": "ON",
        "ENGINE_ENABLE_OPENGL": "OFF"
      },
      "condition": {
        "type": "equals",
        "lhs": "${hostSystemName}",
        "rhs": "Darwin"
      }
    },
    {
      "name": "windows",
      "inherits": "base",
      "displayName": "Windows (Vulkan)",
      "cacheVariables": {
        "ENGINE_ENABLE_VULKAN": "ON",
        "ENGINE_ENABLE_METAL": "OFF",
        "ENGINE_ENABLE_OPENGL": "ON"
      },
      "condition": {
        "type": "equals",
        "lhs": "${hostSystemName}",
        "rhs": "Windows"
      }
    },
    {
      "name": "linux",
      "inherits": "base",
      "displayName": "Linux (Vulkan)",
      "cacheVariables": {
        "ENGINE_ENABLE_VULKAN": "ON",
        "ENGINE_ENABLE_METAL": "OFF",
        "ENGINE_ENABLE_OPENGL": "ON"
      },
      "condition": {
        "type": "equals",
        "lhs": "${hostSystemName}",
        "rhs": "Linux"
      }
    }
  ],
  "buildPresets": [
    {
      "name": "debug",
      "configurePreset": "macos",
      "configuration": "Debug"
    },
    {
      "name": "release",
      "configurePreset": "macos",
      "configuration": "Release"
    }
  ]
}
```

### Build Commands

```bash
# Configure
cmake --preset macos

# Build
cmake --build build --config Debug

# Build with specific target
cmake --build build --config Release --target Editor

# Run
./build/bin/Debug/Editor
```

---

## 6. IDE Setup and Development Workflow

### Recommended IDEs

| IDE | Pros | Cons |
|-----|------|------|
| **CLion** ⭐ | Best CMake support, refactoring, debugging | Paid ($89/yr personal) |
| **VS Code + clangd** | Free, lightweight, great LSP | Debugging setup more complex |
| **Xcode** | Native Mac, Metal debugging | Poor CMake support, no Windows |
| **Visual Studio** | Best on Windows | Mac version limited |

### VS Code Setup (Recommended for Mac)

**Extensions:**
- **clangd** - C++ language server (better than Microsoft C++ extension)
- **CMake Tools** - CMake integration
- **CodeLLDB** - Debugging
- **Shader languages** - GLSL/HLSL syntax

**.vscode/settings.json:**
```json
{
  "cmake.configureOnOpen": true,
  "cmake.buildDirectory": "${workspaceFolder}/build",
  "cmake.generator": "Ninja Multi-Config",
  
  "clangd.arguments": [
    "--background-index",
    "--clang-tidy",
    "--header-insertion=never",
    "--completion-style=detailed",
    "--function-arg-placeholders=false"
  ],
  
  "files.associations": {
    "*.glsl": "glsl",
    "*.vert": "glsl",
    "*.frag": "glsl",
    "*.metal": "cpp"
  },
  
  "[cpp]": {
    "editor.formatOnSave": true
  }
}
```

**.vscode/launch.json:**
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Editor",
      "type": "lldb",
      "request": "launch",
      "program": "${workspaceFolder}/build/bin/Debug/Editor",
      "args": [],
      "cwd": "${workspaceFolder}",
      "env": {
        "VULKAN_SDK": "/usr/local/share/vulkan",
        "VK_ICD_FILENAMES": "/usr/local/share/vulkan/icd.d/MoltenVK_icd.json"
      }
    },
    {
      "name": "Debug Runtime",
      "type": "lldb",
      "request": "launch",
      "program": "${workspaceFolder}/build/bin/Debug/Runtime",
      "args": ["--scene", "assets/scenes/test.scene"],
      "cwd": "${workspaceFolder}"
    }
  ]
}
```

### .clang-format

```yaml
# .clang-format
---
Language: Cpp
BasedOnStyle: LLVM
AccessModifierOffset: -4
AlignAfterOpenBracket: Align
AlignConsecutiveAssignments: false
AlignConsecutiveMacros: true
AlignOperands: true
AlignTrailingComments: true
AllowAllParametersOfDeclarationOnNextLine: true
AllowShortBlocksOnASingleLine: Empty
AllowShortCaseLabelsOnASingleLine: false
AllowShortFunctionsOnASingleLine: Inline
AllowShortIfStatementsOnASingleLine: Never
AllowShortLoopsOnASingleLine: false
AlwaysBreakTemplateDeclarations: Yes
BinPackArguments: true
BinPackParameters: true
BreakBeforeBraces: Attach
BreakConstructorInitializers: BeforeColon
ColumnLimit: 120
IndentCaseLabels: false
IndentWidth: 4
NamespaceIndentation: None
PointerAlignment: Left
SortIncludes: true
SortUsingDeclarations: true
SpaceAfterCStyleCast: false
SpaceAfterTemplateKeyword: false
SpaceBeforeAssignmentOperators: true
SpaceBeforeParens: ControlStatements
SpaceInEmptyParentheses: false
SpacesInAngles: false
SpacesInContainerLiterals: false
SpacesInParentheses: false
SpacesInSquareBrackets: false
Standard: c++20
TabWidth: 4
UseTab: Never
...
```

### .clangd

```yaml
# .clangd
CompileFlags:
  Add:
    - -std=c++20
    - -Wall
    - -Wextra
    - -Wpedantic
  Remove:
    - -W*  # Remove warnings added by compile_commands.json

Diagnostics:
  ClangTidy:
    Add:
      - modernize-*
      - performance-*
      - bugprone-*
      - cppcoreguidelines-*
    Remove:
      - modernize-use-trailing-return-type
      - cppcoreguidelines-avoid-magic-numbers

Index:
  Background: Build

InlayHints:
  Enabled: true
  ParameterNames: true
  DeducedTypes: true
```

### Development Workflow

```bash
# 1. Initial setup
git clone <repo>
cd engine
cmake --preset macos

# 2. Daily development
cmake --build build --config Debug -j$(sysctl -n hw.ncpu)
./build/bin/Debug/Editor

# 3. Before commit
cmake --build build --config Release
ctest --test-dir build --build-config Release

# 4. Format code
find engine editor runtime -name "*.cpp" -o -name "*.hpp" | xargs clang-format -i

# 5. Profile (Instruments on Mac)
cmake --build build --config RelWithDebInfo
open -a Instruments ./build/bin/RelWithDebInfo/Editor
```

---

## Appendix: Recommended Libraries

### Core

| Category | Library | Notes |
|----------|---------|-------|
| **Math** | [GLM](https://github.com/g-truc/glm) | Header-only, GLSL-like syntax |
| **Window/Input** | [SDL3](https://libsdl.org/) | Cross-platform, mature |
| **Logging** | [spdlog](https://github.com/gabime/spdlog) | Fast, fmt-based |
| **JSON** | [nlohmann/json](https://github.com/nlohmann/json) | Intuitive API |
| **ECS** | [EnTT](https://github.com/skypjack/entt) | Fast, header-only |

### Graphics

| Category | Library | Notes |
|----------|---------|-------|
| **Vulkan Memory** | [VMA](https://github.com/GPUOpen-LibrariesAndSDKs/VulkanMemoryAllocator) | AMD, essential for Vulkan |
| **SPIR-V** | [SPIRV-Cross](https://github.com/KhronosGroup/SPIRV-Cross) | Shader reflection + cross-compilation |
| **GLSL Compiler** | [glslang](https://github.com/KhronosGroup/glslang) | GLSL → SPIR-V |
| **Image Loading** | [stb_image](https://github.com/nothings/stb) | Single header |
| **Model Loading** | [tinygltf](https://github.com/syoyo/tinygltf) | glTF 2.0 |
| **Font Rendering** | [FreeType](https://freetype.org/) + [msdf-atlas-gen](https://github.com/Chlumsky/msdf-atlas-gen) | SDF fonts |

### Scripting & UI

| Category | Library | Notes |
|----------|---------|-------|
| **Scripting** | [Lua 5.4](https://www.lua.org/) + [sol2](https://github.com/ThePhD/sol2) | Clean C++ binding |
| **Editor UI** | [Dear ImGui](https://github.com/ocornut/imgui) | Immediate mode, docking branch |
| **In-game UI** | [RmlUi](https://github.com/mikke89/RmlUi) | HTML/CSS-like, retained mode |

### Physics & Audio

| Category | Library | Notes |
|----------|---------|-------|
| **Physics** | [Jolt](https://github.com/jrouwe/JoltPhysics) | Modern, well-documented, used by Horizon |
| **Audio** | [miniaudio](https://github.com/mackron/miniaudio) | Single header, cross-platform |

### Utilities

| Category | Library | Notes |
|----------|---------|-------|
| **File Watching** | [efsw](https://github.com/SpartanJ/efsw) | Cross-platform |
| **Profiling** | [Tracy](https://github.com/wolfpld/tracy) | Real-time profiler |
| **Testing** | [Catch2](https://github.com/catchorg/Catch2) | Header-only |
| **Reflection** | [refl-cpp](https://github.com/veselink1/refl-cpp) | Compile-time reflection |

---

## Quick Start Checklist

```
[ ] Install Xcode Command Line Tools: xcode-select --install
[ ] Install Homebrew: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
[ ] Install dependencies: brew install cmake ninja
[ ] Clone vcpkg: git clone https://github.com/microsoft/vcpkg.git ~/vcpkg
[ ] Bootstrap vcpkg: ~/vcpkg/bootstrap-vcpkg.sh
[ ] Set VCPKG_ROOT: echo 'export VCPKG_ROOT="$HOME/vcpkg"' >> ~/.zshrc
[ ] Install Vulkan SDK from https://vulkan.lunarg.com/sdk/home
[ ] Configure: cmake --preset macos
[ ] Build: cmake --build build --config Debug
[ ] Run: ./build/bin/Debug/Editor
```

---

*Document last updated: January 2026*
