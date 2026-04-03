type Presentation = {
  type?: string
  command?: string
}

function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function presentation(metadata: Record<string, any>): Presentation | undefined {
  if (object(metadata.presentation)) return metadata.presentation
}

export function terminal(metadata: Record<string, any>) {
  return presentation(metadata)?.type === "terminal"
}

export function command(props: {
  tool: string
  title?: string
  input: Record<string, any>
  metadata: Record<string, any>
}) {
  if (typeof props.input.command === "string" && props.input.command) return props.input.command
  const info = presentation(props.metadata)
  if (typeof info?.command === "string" && info.command) return info.command
  if (props.title) return props.title
  return props.tool
}
