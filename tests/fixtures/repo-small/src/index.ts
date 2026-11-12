import { shout } from './util.js'

export function greet(name: string): string {
  return shout(`hello ${name}`)
}
