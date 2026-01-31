#!/bin/bash
set -e

echo "Running all benchmarks..."
echo "=========================="
echo ""

# Create output directory if it doesn't exist
mkdir -p benchmarks/output

# List of models to benchmark
models=(
  "anthropic/claude-opus-4-5-20251101"
  "anthropic/claude-sonnet-4-5-20250929"
  "openai/gpt-5.2-codex"
  "google/gemini-3-pro-preview"
)

for model in "${models[@]}"; do
  echo "Starting benchmark for: $model"
  echo "----------------------------"
  # Create a safe filename from model name
  model_safe=$(echo "$model" | tr '/' '-')
  PYTHONUNBUFFERED=1 python benchmarks/bench.py --model "$model" --agent build 2>&1 | tee "benchmarks/output/run-$model_safe.log"
  echo ""
  echo "Completed: $model"
  echo "=========================="
  echo ""
done

echo "All benchmarks complete!"
