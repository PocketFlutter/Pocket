#!/usr/bin/env python3
"""Render the README's historical Android raster chart.

Run: uv run --with matplotlib==3.11.2 python docs/render_readme_charts.py
Source: sdk/docs/ANDROID_IMPELLER_SCISSOR.md (Profile ablation table).
"""
from pathlib import Path
import argparse
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[1]
BASELINE = (56.451, 61.226)  # median, p95; 154 frames
FIXED = (3.084, 3.978)       # median, p95; 483 frames


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview", type=Path, help="Optional PNG for visual review")
    args = parser.parse_args()
    source = (ROOT / "sdk/docs/ANDROID_IMPELLER_SCISSOR.md").read_text()
    for value in (*BASELINE, *FIXED):
        assert f"{value:.3f}" in source, f"Missing source value: {value}"
    plt.rcParams.update({
        "font.family": "DejaVu Sans", "font.size": 11,
        "svg.fonttype": "none", "svg.hashsalt": "pocket-readme-raster-v1",
        "text.color": "#172b45", "axes.labelcolor": "#526175",
        "xtick.color": "#526175", "ytick.color": "#172b45",
    })
    fig, axes = plt.subplots(1, 2, figsize=(11, 3.9), facecolor="#f6f8fb")
    fig.subplots_adjust(left=.12, right=.97, top=.68, bottom=.29, wspace=.45)
    fig.text(.045, .90, "Android raster duration", fontsize=21, weight="bold")
    fig.text(.045, .81, "Historical Profile experiment  /  milliseconds  /  lower is better", fontsize=11, color="#526175")
    for i, ax in enumerate(axes):
        ax.set_facecolor("#f6f8fb")
        values = [BASELINE[i], FIXED[i]]
        bars = ax.barh([1, 0], values, height=.48, color=["#d27b63", "#168773"], zorder=3)
        ax.set_yticks([1, 0], ["Baseline", "Fixed"])
        ax.set_xlim(0, 74)
        ax.set_xticks([0, 20, 40, 60])
        ax.grid(axis="x", color="#dce3eb", linewidth=.8, zorder=0)
        ax.tick_params(axis="both", length=0, pad=7)
        for spine in ax.spines.values():
            spine.set_visible(False)
        ax.set_title(["Median", "p95"][i], loc="left", fontsize=13, weight="bold", pad=12)
        for bar, value in zip(bars, values):
            ax.text(value + 1, bar.get_y() + bar.get_height()/2, f"{value:.3f}", va="center", fontsize=11, weight="bold")
    fig.text(.045, .15, "MAA_AN00 / SM7550  |  Flutter 3.35.7  |  Impeller Vulkan  |  baseline n=154, fixed n=483", fontsize=9, color="#526175")
    fig.text(.045, .075, "Fix: retain rectangular clips; disable clip-edge antialiasing. Source: sdk/docs/ANDROID_IMPELLER_SCISSOR.md", fontsize=8.5, color="#526175")
    output = ROOT / "docs/assets/android-raster.svg"
    output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output, facecolor=fig.get_facecolor(), metadata={"Date": None, "Creator": "Pocket README chart"})
    if args.preview:
        fig.savefig(args.preview, dpi=150, facecolor=fig.get_facecolor())
    plt.close(fig)
    print(output.relative_to(ROOT))


if __name__ == "__main__":
    main()
