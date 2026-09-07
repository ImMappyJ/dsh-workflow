"""Windows 系统原生文件夹选择器（tkinter 调用 SHBrowseForFolderW API）"""
import tkinter as tk
from tkinter import filedialog
import sys

root = tk.Tk()
root.withdraw()
root.attributes('-topmost', True)  # 置顶，用户易见
folder = filedialog.askdirectory(title="选择工作目录")
if folder:
    # 统一输出正斜杠路径
    sys.stdout.write(folder.replace('\\', '/'))
else:
    sys.stdout.write('')