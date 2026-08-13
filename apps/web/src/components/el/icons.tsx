/**
 * Element Plus 用到的图标（@element-plus/icons-vue 的 React 对等件）。
 *
 * 路径数据从 element-plus@2.13.3 渲染结果原样抄出，外层 <i class="el-icon"> 也保持一致 ——
 * el-icon / el-select__caret / el-message__icon 等样式都挂在这一层。
 */
import type { CSSProperties, MouseEventHandler, ReactNode } from 'react';

interface IconProps {
  className?: string;
  style?: CSSProperties;
  onClick?: MouseEventHandler<HTMLElement>;
  children: ReactNode;
}

function Icon({ className, style, onClick, children }: IconProps) {
  return (
    <i className={className ? `el-icon ${className}` : 'el-icon'} style={style} onClick={onClick}>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
        {children}
      </svg>
    </i>
  );
}

export function ArrowDownIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path
        fill="currentColor"
        d="M831.872 340.864 512 652.672 192.128 340.864a30.59 30.59 0 0 0-42.752 0 29.12 29.12 0 0 0 0 41.6L489.664 714.24a32 32 0 0 0 44.672 0l340.288-331.712a29.12 29.12 0 0 0 0-41.728 30.59 30.59 0 0 0-42.752 0z"
      />
    </Icon>
  );
}

export function LoadingIcon({ className }: { className?: string }) {
  return (
    <Icon className={className ? `${className} is-loading` : 'is-loading'}>
      <path
        fill="currentColor"
        d="M512 64a32 32 0 0 1 32 32v192a32 32 0 0 1-64 0V96a32 32 0 0 1 32-32m0 640a32 32 0 0 1 32 32v192a32 32 0 1 1-64 0V736a32 32 0 0 1 32-32m448-192a32 32 0 0 1-32 32H736a32 32 0 1 1 0-64h192a32 32 0 0 1 32 32m-640 0a32 32 0 0 1-32 32H96a32 32 0 0 1 0-64h192a32 32 0 0 1 32 32M195.2 195.2a32 32 0 0 1 45.248 0L376.32 331.008a32 32 0 0 1-45.248 45.248L195.2 240.448a32 32 0 0 1 0-45.248m452.544 452.544a32 32 0 0 1 45.248 0L828.8 783.552a32 32 0 0 1-45.248 45.248L647.744 692.992a32 32 0 0 1 0-45.248M828.8 195.264a32 32 0 0 1 0 45.184L692.992 376.32a32 32 0 0 1-45.248-45.248l135.808-135.808a32 32 0 0 1 45.248 0m-452.544 452.48a32 32 0 0 1 0 45.248L240.448 828.8a32 32 0 0 1-45.248-45.248l135.808-135.808a32 32 0 0 1 45.248 0"
      />
    </Icon>
  );
}

export function CircleCheckIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path
        fill="currentColor"
        d="M512 896a384 384 0 1 0 0-768 384 384 0 0 0 0 768m0 64a448 448 0 1 1 0-896 448 448 0 0 1 0 896"
      />
      <path
        fill="currentColor"
        d="M745.344 361.344a32 32 0 0 1 45.312 45.312l-288 288a32 32 0 0 1-45.312 0l-160-160a32 32 0 1 1 45.312-45.312L480 626.752z"
      />
    </Icon>
  );
}

export function CloseIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path
        fill="currentColor"
        d="M764.288 214.592 512 466.88 259.712 214.592a31.936 31.936 0 0 0-45.12 45.12L466.752 512 214.528 764.224a31.936 31.936 0 1 0 45.12 45.184L512 557.184l252.288 252.288a31.936 31.936 0 0 0 45.12-45.12L557.12 512.064l252.288-252.352a31.936 31.936 0 1 0-45.12-45.184z"
      />
    </Icon>
  );
}

export function QuestionFilledIcon({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <Icon className={className} style={style}>
      <path
        fill="currentColor"
        d="M512 64a448 448 0 1 1 0 896 448 448 0 0 1 0-896m23.744 191.488c-52.096 0-92.928 14.784-123.2 44.352-30.976 29.568-45.76 70.4-45.76 122.496h80.256c0-29.568 5.632-52.8 17.6-68.992 13.376-19.712 35.2-28.864 66.176-28.864 23.936 0 42.944 6.336 56.32 19.712 12.672 13.376 19.712 31.68 19.712 54.912 0 17.6-6.336 34.496-19.008 49.984l-8.448 9.856c-45.76 40.832-73.216 70.4-82.368 89.408-9.856 19.008-14.08 42.24-14.08 68.992v9.856h80.96v-9.856c0-16.896 3.52-31.68 10.56-45.76 6.336-12.672 15.488-24.64 28.16-35.2 33.792-29.568 54.208-48.576 60.544-55.616 16.896-22.528 26.048-51.392 26.048-86.592q0-64.416-42.24-101.376c-28.16-25.344-65.472-37.312-111.232-37.312m-12.672 406.208a54.27 54.27 0 0 0-38.72 14.784 49.4 49.4 0 0 0-15.488 38.016c0 15.488 4.928 28.16 15.488 38.016A54.85 54.85 0 0 0 523.072 768c15.488 0 28.16-4.928 38.72-14.784a51.52 51.52 0 0 0 16.192-38.72 51.97 51.97 0 0 0-15.488-38.016 55.94 55.94 0 0 0-39.424-14.784"
      />
    </Icon>
  );
}

export function SuccessFilledIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path
        fill="currentColor"
        d="M512 64a448 448 0 1 1 0 896 448 448 0 0 1 0-896m-55.808 536.384-99.52-99.584a38.4 38.4 0 1 0-54.336 54.336l126.72 126.72a38.27 38.27 0 0 0 54.336 0l262.4-262.464a38.4 38.4 0 1 0-54.272-54.336z"
      />
    </Icon>
  );
}

export function CircleCloseFilledIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path
        fill="currentColor"
        d="M512 64a448 448 0 1 1 0 896 448 448 0 0 1 0-896m0 393.664L407.936 353.6a38.4 38.4 0 1 0-54.336 54.336L457.664 512 353.6 616.064a38.4 38.4 0 1 0 54.336 54.336L512 566.336 616.064 670.4a38.4 38.4 0 1 0 54.336-54.336L566.336 512 670.4 407.936a38.4 38.4 0 1 0-54.336-54.336z"
      />
    </Icon>
  );
}

export function WarningFilledIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path
        fill="currentColor"
        d="M512 64a448 448 0 1 1 0 896 448 448 0 0 1 0-896m0 192a58.43 58.43 0 0 0-58.24 63.744l23.36 256.384a35.072 35.072 0 0 0 69.76 0l23.296-256.384A58.43 58.43 0 0 0 512 256m0 512a51.2 51.2 0 1 0 0-102.4 51.2 51.2 0 0 0 0 102.4"
      />
    </Icon>
  );
}

export function InfoFilledIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path
        fill="currentColor"
        d="M512 64a448 448 0 1 1 0 896.064A448 448 0 0 1 512 64m67.2 275.072c33.28 0 60.288-23.104 60.288-57.344s-27.072-57.344-60.288-57.344c-33.28 0-60.16 23.104-60.16 57.344s26.88 57.344 60.16 57.344M590.912 699.2c0-6.848 2.368-24.64 1.024-34.752l-52.608 60.544c-10.88 11.456-24.512 19.392-30.912 17.28a12.99 12.99 0 0 1-8.256-14.72l87.68-276.992c7.168-35.136-12.544-67.2-54.336-71.296-44.096 0-108.992 44.736-148.48 101.504 0 6.784-1.28 23.68.064 33.792l52.544-60.608c10.88-11.328 23.552-19.328 29.952-17.152a12.8 12.8 0 0 1 7.808 16.128L388.48 728.576c-10.048 32.256 8.96 63.872 55.04 71.04 67.84 0 107.904-43.648 147.456-100.416z"
      />
    </Icon>
  );
}

export function CircleCloseIcon({
  className,
  onClick,
}: {
  className?: string;
  onClick?: MouseEventHandler<HTMLElement>;
}) {
  return (
    <Icon className={className} onClick={onClick}>
      <path
        fill="currentColor"
        d="m466.752 512-90.496-90.496a32 32 0 0 1 45.248-45.248L512 466.752l90.496-90.496a32 32 0 1 1 45.248 45.248L557.248 512l90.496 90.496a32 32 0 1 1-45.248 45.248L512 557.248l-90.496 90.496a32 32 0 0 1-45.248-45.248z"
      />
      <path
        fill="currentColor"
        d="M512 896a384 384 0 1 0 0-768 384 384 0 0 0 0 768m0 64a448 448 0 1 1 0-896 448 448 0 0 1 0 896"
      />
    </Icon>
  );
}
