# SPH Fluid Simulation - Technical Plan

## Overview
Smoothed Particle Hydrodynamics (SPH) simulates fluids as a collection of particles, each carrying properties like position, velocity, density, and pressure. Particles interact with neighbors within a smoothing radius.

## Core Algorithm

### 1. Particle Data Structure
```javascript
{
  position: vec3,      // x, y, z
  velocity: vec3,      // vx, vy, vz
  acceleration: vec3,  // ax, ay, az
  density: float,
  pressure: float,
  mass: float,         // typically uniform
}
```

### 2. Simulation Loop (per frame)
```
1. Neighbor Search (spatial hashing or grid)
2. Density Calculation
3. Pressure Calculation
4. Force Computation (pressure + viscosity + external)
5. Integration (update velocity & position)
6. Boundary Handling
7. Surface Reconstruction (for rendering)
```

### 3. Key Equations

**Density at particle i:**
```
ρᵢ = Σⱼ mⱼ · W(rᵢ - rⱼ, h)
```

**Pressure (Tait equation):**
```
Pᵢ = k · ((ρᵢ / ρ₀)^γ - 1)
```
- k = stiffness constant
- ρ₀ = rest density
- γ = typically 7 for water

**Pressure Force:**
```
Fᵢᵖʳᵉˢˢ = -Σⱼ mⱼ · (Pᵢ + Pⱼ)/(2ρⱼ) · ∇W(rᵢ - rⱼ, h)
```

**Viscosity Force:**
```
Fᵢᵛⁱˢᶜ = μ · Σⱼ mⱼ · (vⱼ - vᵢ)/ρⱼ · ∇²W(rᵢ - rⱼ, h)
```

### 4. Smoothing Kernels

**Poly6 Kernel (for density):**
```
W(r, h) = 315/(64πh⁹) · (h² - |r|²)³  for |r| ≤ h
```

**Spiky Kernel (for pressure gradient):**
```
∇W(r, h) = -45/(πh⁶) · (h - |r|)² · r/|r|
```

**Viscosity Kernel Laplacian:**
```
∇²W(r, h) = 45/(πh⁶) · (h - |r|)
```

### 5. Neighbor Search - Spatial Hashing
```javascript
// Cell size = smoothing radius h
cellIndex = hash(floor(x/h), floor(y/h), floor(z/h))
// Only search 27 neighboring cells (3x3x3)
```

### 6. Boundary Handling
- **Particle-based**: Ghost particles along walls
- **Penalty force**: Spring-like repulsion from boundaries
- **Position correction**: Clamp + reflect velocity

### 7. Time Integration (Leapfrog)
```
v(t + Δt/2) = v(t - Δt/2) + a(t) · Δt
x(t + Δt) = x(t) + v(t + Δt/2) · Δt
```

### 8. Surface Reconstruction (for rendering)
- **Marching Cubes**: Extract isosurface from density field
- **Screen-space**: Render particles as spheres, blur, extract normals
- **Point splatting**: Simple but effective for real-time

## Performance Considerations

| Component | CPU | GPU (WebGPU) |
|-----------|-----|--------------|
| 1K particles | 60fps | 60fps |
| 10K particles | 15fps | 60fps |
| 50K particles | 2fps | 45fps |

## WebGPU Implementation Path
1. Compute shader for neighbor search
2. Compute shader for density/pressure
3. Compute shader for forces
4. Compute shader for integration
5. Vertex shader for particle rendering

## Parameters to Tune
- `h` (smoothing radius): 0.1 - 0.5
- `k` (stiffness): 1000 - 5000
- `μ` (viscosity): 0.1 - 5.0
- `ρ₀` (rest density): 1000 (water)
- `Δt` (timestep): 0.001 - 0.01
- `mass`: derive from particle spacing

## Implementation Phases

### Phase 1: CPU Prototype
- [ ] Particle system data structures
- [ ] Basic integration (gravity + damping)
- [ ] Boundary collision (box)
- [ ] Simple point rendering

### Phase 2: SPH Forces
- [ ] Neighbor search (brute force first)
- [ ] Density calculation
- [ ] Pressure forces
- [ ] Viscosity forces
- [ ] Tune parameters

### Phase 3: Optimization
- [ ] Spatial hashing for neighbor search
- [ ] SIMD optimizations where possible
- [ ] Web Workers for parallel computation

### Phase 4: WebGPU Migration
- [ ] Port particle data to GPU buffers
- [ ] Compute shaders for simulation
- [ ] Instanced rendering for particles

### Phase 5: Visual Polish
- [ ] Surface reconstruction
- [ ] Water shader (refraction, reflection)
- [ ] Foam/splash particles
- [ ] Integration with scene objects

## Resources
- [SPH Fluids in Games (GDC)](https://www.gdcvault.com)
- [Müller et al. 2003 - Particle-Based Fluid Simulation](https://matthias-research.github.io/pages/publications/sca03.pdf)
- [Position Based Fluids (NVIDIA)](https://mmacklin.com/pbf_sig_preprint.pdf)
- [Ten Minute Physics - SPH Tutorial](https://matthias-research.github.io/pages/tenMinutePhysics/)
