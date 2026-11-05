import { useEffect } from "react"
import { animate, motion, useMotionValue, useTransform } from "motion/react"

/** A number that eases to each new value instead of flickering. */
export function Tween({
  value,
  format,
  duration = 0.4,
  className,
}: {
  value: number
  format: (v: number) => string
  duration?: number
  className?: string
}) {
  const mv = useMotionValue(value)
  const text = useTransform(mv, format)
  useEffect(() => {
    const c = animate(mv, value, { duration, ease: [0.25, 1, 0.5, 1] })
    return () => c.stop()
  }, [mv, value, duration])
  return <motion.span className={className}>{text}</motion.span>
}
