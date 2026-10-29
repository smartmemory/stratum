// Stand-in for the Base44 app's `cn` (clsx + tailwind-merge): joins truthy class names.
export function cn(...parts) {
  return parts.flat(Infinity).filter(Boolean).join(' ');
}
