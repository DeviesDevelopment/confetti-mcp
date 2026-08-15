import type { Operation } from '../confetti/resource-map.js'

export function camelToSnake(value: string): string {
  return value.replace(/([A-Z])/g, '_$1').toLowerCase()
}

export function toolName(resourceName: string, operation: Operation): string {
  return `confetti_${camelToSnake(resourceName)}_${camelToSnake(operation)}`
}
