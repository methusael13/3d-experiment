/**
 * Prepare Cull Dispatch — tiny 1-thread compute shader
 * 
 * Reads the actual instance count from the spawn counter buffer
 * and writes the indirect dispatch args for the cull shader.
 * 
 * This enables dispatchWorkgroupsIndirect so the cull shader
 * only launches exactly the right number of workgroups for
 * the actual spawned instance count (not maxInstances).
 * 
 * Dispatch args layout (3 × u32 = 12 bytes):
 *   [0] workgroupCountX = ceil(actualCount / 256)
 *   [1] workgroupCountY = 1
 *   [2] workgroupCountZ = 1
 */

const CULL_WORKGROUP_SIZE: u32 = 256u;

@group(0) @binding(0) var<storage, read> spawnCounters: array<u32>;
@group(0) @binding(1) var<storage, read_write> dispatchArgs: array<u32>;

@compute @workgroup_size(1)
fn main() {
  let actualCount = spawnCounters[0];
  let workgroups = (actualCount + CULL_WORKGROUP_SIZE - 1u) / CULL_WORKGROUP_SIZE;
  
  dispatchArgs[0] = workgroups;
  dispatchArgs[1] = 1u;
  dispatchArgs[2] = 1u;
}