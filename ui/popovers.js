export function hideMenus(root, except = null) {
  for (const menu of root.querySelectorAll('.pv-select-popover, .pv-theme-menu')) {
    if (menu !== except && menu.matches(':popover-open')) menu.hidePopover();
  }
}

export function showMenu(root, menu) {
  hideMenus(root, menu);
  menu.showPopover();
}
