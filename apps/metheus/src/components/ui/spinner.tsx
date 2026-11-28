import { cn } from "cn"
import { LoaderCircleIcon } from "@/components/icons"

function Spinner({ className, ...props }: React.ComponentProps<typeof LoaderCircleIcon>) {
  return (
    <LoaderCircleIcon animateOnInteraction={false} data-slot="spinner" role="status" aria-label="Loading" aria-hidden={false}
      className={cn("size-4 motion-safe:animate-spin", className)} {...props} />
  )
}

export { Spinner }
