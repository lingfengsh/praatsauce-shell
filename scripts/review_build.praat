# review_build.praat  —— 基频/共振峰审查候选生成
#
# 用法（由后端调用，已带 --FULL-TRUST）：
#   praat --FULL-TRUST --run review_build.praat <wavPath> <outDir>
#
# 对同一段录音生成多组候选，方便在前端叠加比较、选最优、再手动修正：
#   - Pitch  候选：扫描 f0 上限（ceiling）
#   - Formant 候选：**二维扫描** 共振峰上限（ceiling）× 共振峰数量（maxNumberOfFormants）
# 每组候选另存为 Praat 文本对象，后端用 praat_objects 读回即可，无需启动 GUI。
#
# 为什么数量也要扫：Praat 手册（Sound: To Formant (burg)...）明说 Maximum number of
# formants 与 Formant ceiling 是**一对**参数，只有配套才能让 F1/F2 保持
# "舌位高低 / 舌位前后" 的可解释性；LPC 阶数 = 2 × 数量，数量选小了（如 4）会把
# F1/F2 糊成一个包络峰，F1 实测会虚高到 1100 Hz 以上。手册推荐值就是 5。

form Review build
  sentence wavPath ./sample.wav
  sentence outDir ./review_out
endform

Read from file: wavPath$

if selected("Sound", 1) = 0
  exitScript: "未读取到声音对象，请检查 wav 路径"
endif
sound = selected("Sound", 1)

# ---------------------- Pitch 候选（不同 f0 上限） ----------------------
# 用 if/elsif 逐个取 ceiling，避免旧版 Praat 不支持向量字面量 { }
for pIndex to 3
  selectObject: sound
  if pIndex = 1
    ceil = 400
  elsif pIndex = 2
    ceil = 500
  elsif pIndex = 3
    ceil = 600
  endif
  # 基频抽取统一用 Praat 推荐的滤波自相关（2026-09-25 用户拍板），
  # 与主批量 get_pitch.praat 的 pitchMethod=0 一致。第 3 参在 filtered 里是 pitch top，
  # 这里仍填候选的 f0 上限；其余取 Praat 标准值。
  To Pitch (filtered autocorrelation): 0.0, 75, ceil, 15, 0, 0.03, 0.09, 0.5, 0.055, 0.35, 0.14
  Save as text file: outDir$ + "/pitch_" + string$(ceil) + ".pitch"
  Remove
endfor

# -------------- Formant 候选（共振峰上限 × 共振峰数量） --------------
# 外层扫 ceiling（5 档），内层扫 maxNumberOfFormants（4/5/6/7 共 4 档）→ 20 组。
# 文件名带两个数字：formant_<上限>_<数量>.formant（后端靠它还原候选标签）。
# 上限 5 档的依据（2026-09-26 用户拍板改为 -2..+2 五档）：Praat FormantPath 标准阶梯——
#   ceilingStep=0.05 是**对数域**步长（×e^0.05），以 5500（Praat 男女通用标准默认值）
#   为中心 → 5500·e^(±0.05k)：4503.0 / 4733.9 / 4976.6 / 5231.8 / 5500 / 5782.0 /
#   6078.4 / 6390.1 / 6717.7（本机 Praat 7.0.02 实测，见 backend/formant_path.py 头注释）。
# 这里取 **-2/-1/0/+1/+2 五档精确值**（取整到 4977/5232/5500/5782/6078，偏差 <0.5 Hz）；
# 要更外侧的档（4503 低档 / 6390、6718 高档，如女声 F3/F4 偏高时）→ 详情页点
# 「FormantPath 编辑器」跑全 9 档逐段择优。
for fIndex to 5
  if fIndex = 1
    fceil = 4977
  elsif fIndex = 2
    fceil = 5232
  elsif fIndex = 3
    fceil = 5500
  elsif fIndex = 4
    fceil = 5782
  elsif fIndex = 5
    fceil = 6078
  endif
  for nIndex to 4
    if nIndex = 1
      nF = 4
    elsif nIndex = 2
      nF = 5
    elsif nIndex = 3
      nF = 6
    elsif nIndex = 4
      nF = 7
    endif
    selectObject: sound
    # ⚠ 参数顺序（Praat 真实签名，写错会静默产出垃圾值）：
    #   timeStep, maxNumberOfFormants, maximumFormant, windowLength, preEmphasisFrom
    #   曾写成 "0.0, 5, 0, 0.025, ceil" → maximumFormant=0、preEmphasis=ceil，
    #   结果是共振峰退化成 6000~19000Hz 的无意义值。此处 ceiling 必须在第 3 位。
    To Formant (burg): 0.0, nF, fceil, 0.025, 50
    Save as text file: outDir$ + "/formant_" + string$(fceil) + "_" + string$(nF) + ".formant"
    Remove
  endfor
endfor

writeInfoLine: "OK review_build done"
