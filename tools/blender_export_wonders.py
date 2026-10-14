"""
blender_export_wonders.py
-----------------------------------------------------------------------------
Batch-exports the seven wonders from one .blend file into web-ready assets:

    assets/models/<id>.glb          LOD0, desktop   (Draco, <= --lod0 tris)
    assets/models/<id>.mobile.glb   LOD1, mobile    (Draco, <= --lod1 tris)
    assets/models/<id>.points.bin   Float32 xyz point cloud, glTF (Y-up) space,
                                    exactly --points samples, area-weighted

Expected .blend layout: one top-level collection per wonder, named with the
ids used in data/wonders.json:

    great-wall, petra, christ-the-redeemer, machu-picchu,
    chichen-itza, colosseum, taj-mahal

Objects whose name starts with "NP_" (ground, water, terrain) are exported but
left out of the point cloud — same rule as userData.noParticles in the site.

Run headless (Blender 4.2+):

    blender -b wonders.blend --python tools/blender_export_wonders.py -- \
        --out assets/models --lod0 150000 --lod1 50000 --points 60000

Nothing in the .blend is modified permanently: decimation is a temporary
modifier applied only at export time (export_apply=True) and removed after.
-----------------------------------------------------------------------------
"""
import argparse
import os
import sys

import bpy
import numpy as np

WONDER_IDS = [
    "great-wall", "petra", "christ-the-redeemer", "machu-picchu",
    "chichen-itza", "colosseum", "taj-mahal",
]


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="assets/models")
    p.add_argument("--lod0", type=int, default=150_000, help="max triangles, desktop")
    p.add_argument("--lod1", type=int, default=50_000, help="max triangles, mobile")
    p.add_argument("--points", type=int, default=60_000, help="point-cloud samples")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--only", nargs="*", default=None, help="subset of wonder ids")
    return p.parse_args(argv)


def mesh_objects(collection):
    return [o for o in collection.all_objects if o.type == "MESH"]


def triangle_count(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    total = 0
    for o in objs:
        ev = o.evaluated_get(dg)
        m = ev.to_mesh()
        m.calc_loop_triangles()
        total += len(m.loop_triangles)
        ev.to_mesh_clear()
    return total


def select_only(objs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]


def export_glb(objs, path, max_tris):
    """Export with a temporary Decimate modifier so the result fits max_tris."""
    tris = triangle_count(objs)
    ratio = min(1.0, max_tris / max(tris, 1))
    mods = []
    if ratio < 0.999:
        for o in objs:
            m = o.modifiers.new("WEB_LOD", "DECIMATE")
            m.decimate_type = "COLLAPSE"
            m.ratio = ratio
            m.use_collapse_triangulate = True
            mods.append((o, m))
    try:
        select_only(objs)
        bpy.ops.export_scene.gltf(
            filepath=path,
            export_format="GLB",
            use_selection=True,
            export_apply=True,               # bakes modifiers, incl. the temporary decimate
            export_yup=True,
            export_texcoords=True,
            export_normals=True,
            export_tangents=False,           # let three.js derive them; saves bytes
            export_materials="EXPORT",
            export_image_format="AUTO",      # PNG/JPEG as authored; see BLUEPRINT for KTX2
            export_cameras=False,
            export_lights=False,
            export_animations=False,
            export_draco_mesh_compression_enable=True,
            export_draco_mesh_compression_level=6,
            export_draco_position_quantization=14,
            export_draco_normal_quantization=10,
            export_draco_texcoord_quantization=12,
            export_draco_color_quantization=10,
            export_draco_generic_quantization=12,
        )
    finally:
        for o, m in mods:
            o.modifiers.remove(m)
    after = triangle_count(objs) if not mods else int(tris * ratio)
    return tris, after


def sample_points(objs, count, seed):
    """Area-weighted uniform surface samples, Blender Z-up → glTF Y-up."""
    dg = bpy.context.evaluated_depsgraph_get()
    tris = []
    for o in objs:
        if o.name.startswith("NP_"):
            continue
        ev = o.evaluated_get(dg)
        m = ev.to_mesh()
        m.calc_loop_triangles()
        mw = np.array(ev.matrix_world)
        co = np.empty(len(m.vertices) * 3, dtype=np.float64)
        m.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        co = (np.c_[co, np.ones(len(co))] @ mw.T)[:, :3]
        idx = np.empty(len(m.loop_triangles) * 3, dtype=np.int64)
        m.loop_triangles.foreach_get("vertices", idx)
        tris.append(co[idx.reshape(-1, 3)])
        ev.to_mesh_clear()
    if not tris:
        raise RuntimeError("no sampleable meshes")
    T = np.concatenate(tris)                       # (n, 3, 3)
    a, b, c = T[:, 0], T[:, 1], T[:, 2]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    rng = np.random.default_rng(seed)
    pick = rng.choice(len(T), size=count, p=area / area.sum())
    u, v = rng.random(count), rng.random(count)
    flip = u + v > 1
    u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
    P = a[pick] + (b[pick] - a[pick]) * u[:, None] + (c[pick] - a[pick]) * v[:, None]
    # Blender (x, y, z) Z-up  →  glTF (x, z, -y) Y-up
    return np.stack([P[:, 0], P[:, 2], -P[:, 1]], axis=1).astype(np.float32)


def main():
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)
    ids = args.only or WONDER_IDS
    report = []
    for wid in ids:
        col = bpy.data.collections.get(wid)
        if col is None:
            print(f"[skip] no collection named '{wid}'")
            continue
        objs = mesh_objects(col)
        if not objs:
            print(f"[skip] '{wid}' has no mesh objects")
            continue
        src, lod0 = export_glb(objs, os.path.join(args.out, f"{wid}.glb"), args.lod0)
        _, lod1 = export_glb(objs, os.path.join(args.out, f"{wid}.mobile.glb"), args.lod1)
        pts = sample_points(objs, args.points, args.seed)
        pts.tofile(os.path.join(args.out, f"{wid}.points.bin"))
        size = lambda f: os.path.getsize(os.path.join(args.out, f)) / 1e6
        report.append((wid, src, lod0, lod1, size(f"{wid}.glb"), size(f"{wid}.mobile.glb")))

    print("\n wonder                source    lod0     lod1    lod0 MB  lod1 MB")
    for wid, s, l0, l1, m0, m1 in report:
        flag = "  <-- over 3 MB" if m0 > 3 else ""
        print(f" {wid:20s} {s:8d} {l0:8d} {l1:8d} {m0:8.2f} {m1:8.2f}{flag}")
    print("\nNext: set model.glb / model.glbMobile / model.points in data/wonders.json.")


if __name__ == "__main__":
    main()
