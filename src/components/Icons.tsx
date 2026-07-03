/** Icon components using lucide-react */

import {
  Box,
  Search,
  HardDrive,
  Shield,
  Settings,
  RefreshCw,
  Home,
  ChevronRight,
  ArrowUp,
  Folder,
  File,
  Loader2,
  Trash2,
  AlertTriangle,
  Play,
  ClipboardCopy,
  ListPlus,
  ChevronRight as ChevronRightIcon,
  PackageX,
  Rocket,
  FolderSearch,
} from "lucide-react";

export function IconBox(props: React.ComponentProps<typeof Box>) {
  return <Box size={20} strokeWidth={2} {...props} />;
}

export function IconSearch(props: React.ComponentProps<typeof Search>) {
  return <Search size={20} strokeWidth={2} {...props} />;
}

export function IconHardDrive(props: React.ComponentProps<typeof HardDrive>) {
  return <HardDrive size={20} strokeWidth={2} {...props} />;
}

export function IconShield(props: React.ComponentProps<typeof Shield>) {
  return <Shield size={20} strokeWidth={2} {...props} />;
}

export function IconSettings(props: React.ComponentProps<typeof Settings>) {
  return <Settings size={20} strokeWidth={2} {...props} />;
}

export function IconRefresh(props: React.ComponentProps<typeof RefreshCw>) {
  return <RefreshCw size={18} strokeWidth={2} {...props} />;
}

export function IconHome(props: React.ComponentProps<typeof Home>) {
  return <Home size={16} strokeWidth={2} {...props} />;
}

export function IconChevronRight(props: React.ComponentProps<typeof ChevronRight>) {
  return <ChevronRight size={14} strokeWidth={2} {...props} />;
}

export function IconArrowUp(props: React.ComponentProps<typeof ArrowUp>) {
  return <ArrowUp size={16} strokeWidth={2} {...props} />;
}

export function IconFolder(props: React.ComponentProps<typeof Folder>) {
  return <Folder size={18} strokeWidth={2} {...props} />;
}

export function IconFile(props: React.ComponentProps<typeof File>) {
  return <File size={18} strokeWidth={2} {...props} />;
}

export function IconLoader(props: React.ComponentProps<typeof Loader2>) {
  return <Loader2 size={16} strokeWidth={2} {...props} />;
}

export function IconTrash(props: React.ComponentProps<typeof Trash2>) {
  return <Trash2 size={16} strokeWidth={2} {...props} />;
}

export function IconAlert(props: React.ComponentProps<typeof AlertTriangle>) {
  return <AlertTriangle size={16} strokeWidth={2} {...props} />;
}

export function IconPlay(props: React.ComponentProps<typeof Play>) {
  return <Play size={16} strokeWidth={2} {...props} />;
}

export function IconClipboard(props: React.ComponentProps<typeof ClipboardCopy>) {
  return <ClipboardCopy size={16} strokeWidth={2} {...props} />;
}

export function IconListPlus(props: React.ComponentProps<typeof ListPlus>) {
  return <ListPlus size={16} strokeWidth={2} {...props} />;
}

export function IconChevronRightSmall(
  props: React.ComponentProps<typeof ChevronRightIcon>,
) {
  return <ChevronRightIcon size={14} strokeWidth={2} {...props} />;
}

export function IconPackageX(props: React.ComponentProps<typeof PackageX>) {
  return <PackageX size={20} strokeWidth={2} {...props} />;
}

export function IconRocket(props: React.ComponentProps<typeof Rocket>) {
  return <Rocket size={20} strokeWidth={2} {...props} />;
}

export function IconFolderQuestion(props: React.ComponentProps<typeof FolderSearch>) {
  return <FolderSearch size={20} strokeWidth={2} {...props} />;
}
