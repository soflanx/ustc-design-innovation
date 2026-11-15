type PortalImageData = { src: string; alt: string; width?: number; height?: number };

/** A public-portal picture at a fixed ratio; a plain grey block stands in until a real image is bound. */
export function PortalImage({ image, ratio, priority = false }: { image?: PortalImageData; ratio: string; priority?: boolean }) {
  return <div className="portal-image" style={{ aspectRatio: ratio }}>
    {image && <img src={image.src} alt={image.alt} width={image.width} height={image.height} loading={priority ? undefined : 'lazy'} fetchPriority={priority ? 'high' : undefined}/>}
  </div>;
}
