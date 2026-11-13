import lockup from "../../assets/brand/wordlyte-lockup.png";

type BrandAssetProps = {
  className?: string;
  alt?: string;
};

/**
 * Brand lockup: the custom Wordlyte mark and wordmark from the brand system.
 * Keep this as an image rather than rebuilding the wordmark with Inter; the
 * wordmark itself is custom-drawn.
 */
export function BrandLockup({ className = "h-7 w-auto", alt = "Wordlyte" }: BrandAssetProps) {
  return (
    <img
      src={lockup}
      alt={alt}
      className={`select-none object-contain ${className}`}
      draggable={false}
    />
  );
}
