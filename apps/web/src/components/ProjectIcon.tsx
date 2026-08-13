import './ProjectIcon.css';

export function ProjectIcon({ size = 24 }: { size?: number }) {
  return (
    <img
      className="project-icon"
      src="/project-icon.png"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
    />
  );
}
