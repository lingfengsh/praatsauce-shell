# review_export.praat —— 把审查选定的 F0 / 共振峰导出成 praatSauce 可直接读取的对象
#
# 用法（由后端调用，已带 --FULL-TRUST）：
#   praat --FULL-TRUST --run review_export.praat <inputDir> <workList> <wavExt> <f0min> <timeStep>
#
# workList 每行 = **一个文件一组参数**，用 "|" 分隔：
#     <相对 inputDir 的文件名>|<F0 上限>|<共振峰数量>|<共振峰上限>[|method|silence|voicing|octave|octaveJump|vuv|attenuation[|dims]]
#   例：11.wav|500|5|5500
#   例（自定义基频参数，2026-09-25 详情页滑块存盘）：
#       11.wav|600|5|5500|raw|0.03|0.45|0.01|0.35|0.14|0.03
#       12.wav|800|5|5500|filtered|0.09|0.5|0.055|0.35|0.14|0.03
#   method 为空 = 默认滤波自相关（与主批量 pitchMethod=0 一致），参数走 Praat 标准值；
#   method=raw → To Pitch (raw autocorrelation) 10 参；method=filtered → To Pitch
#   (filtered autocorrelation) 11 参（第 4 参后多 attenuation，"ceiling" 语义为 pitch top）。
#   两命令完整签名于 Praat 7.0.02 实测；very accurate 固定 0（batch 下不认 yes/no）。
#   （参数逐个文件取，因为九宫格里允许不同文件采用不同参数）
#   dims（第 12 段，2026-09-25 存盘分维）：pitch = 只导 .Pitch，formant = 只导 .Formant；
#   空/缺省 = 两个都导（「审核完成」整批落盘时用）。
#
# ⚠️ timeStep 必须 = 批量运行时 params.csv 的 intervalFixed（默认 0.005）。
#    **不能用 0.0（自动步长）**：praatSauce 把各测量序列对齐到统一时间网格时，
#    对**帧数不足**的序列是**补 0**、不做插值。导出对象若是自动步长（F0 约 15 ms、
#    共振峰约 6.25 ms），帧数只有 5 ms 网格的 1/3，读回后 out.tsv 里会出现大量 0 值
#    （实测 f0 列 307 行里 207 行为 0）。步长对齐后该现象消失。
#
# 输出（都写在 wav 同目录，与 praatSauce 读对象的路径规则一致）：
#   <主名>.Pitch            ← pitchReadDir + 主名 + ".Pitch"
#   <主名>.Formant          ← formantReadDir + 主名 + ".Formant"
#
# 本脚本**只负责生成基础对象**。人工修正的 F0 点不在这里合并——因为实测 Praat 7 的
# Pitch 对象没有任何逐帧修改命令（Set value at time / To PitchTier / Shift /
# Set value in frame 全报 "not available for current selection"），
# 所以改由后端 Python 直接改写 .Pitch 文本（见 backend/review_export.py）。
#
# ⚠️ 调用方注意：**脚本中途出错时 stdout 一行都不会输出**（Praat 的 info window 是
# 结束时才 flush）。因此不能靠 stdout 判断成功，必须以「产物文件是否存在」为准；
# 下面的 INFO 行只当日志看。逐文件命令一律加 `nocheck` 并事后检测对象，
# 避免单个坏文件拖垮整批（但 `nocheck` 是"不可用就静默跳过"，不能拿它判断命令是否存在）。

form Review export
  sentence inputDir
  sentence workList
  sentence wavExt
  real f0min
  real timeStep
endform

if not fileReadable(workList$)
  exitScript: "找不到导出清单：", workList$
endif

strs = Read Strings from raw text file: workList$
n = Get number of strings
extLen = length(wavExt$)

# 把 line$ 按 "|" 切进全局字符串数组 tok$[1..nTok]（字符串数组名必须带 $；
# 后缀点变量是过程局部，tok$/nTok 是全局）
procedure SplitLine: .line$
  nTok = 0
  repeat
    b = index(.line$, "|")
    if b > 0
      nTok = nTok + 1
      tok$[nTok] = left$(.line$, b - 1)
      .line$ = mid$(.line$, b + 1, length(.line$) - b)
    else
      nTok = nTok + 1
      tok$[nTok] = .line$
    endif
  until b = 0
endproc

for i to n
  selectObject: strs
  line$ = Get string: i
  @SplitLine: line$

  if nTok >= 4
    name$ = tok$[1]
    pc = number(tok$[2])
    nF = number(tok$[3])
    fc = number(tok$[4])
    # 可选的自定义基频参数（普通候选只有 4 段，method 留空走默认 To Pitch）
    pm$ = ""
    if nTok >= 11
      pm$ = tok$[5]
      pSil = number(tok$[6])
      pVoi = number(tok$[7])
      pOct = number(tok$[8])
      pJmp = number(tok$[9])
      pVuv = number(tok$[10])
      pAtt = number(tok$[11])
    endif
    # 可选的维度限定（第 12 段）：pitch=只导 .Pitch，formant=只导 .Formant，空=都导
    dm$ = ""
    if nTok >= 12
      dm$ = tok$[12]
    endif

    wav$ = inputDir$ + "/" + name$
    base$ = left$(wav$, length(wav$) - extLen)
    # 中间结果统一落 measure/ 子目录（2026-09-27 方案 A）。Praat 不能建目录，
    # Python 侧 _run_batch 已为每个文件 ensure 过；这里只拼路径。
    slash = rindex(base$, "/")
    if slash > 0
      stem$ = right$(base$, length(base$) - slash)
      pitchOut$ = left$(base$, slash) + "/measure/" + stem$ + ".Pitch"
      fmtOut$ = left$(base$, slash) + "/measure/" + stem$ + ".Formant"
    else
      pitchOut$ = "measure/" + base$ + ".Pitch"
      fmtOut$ = "measure/" + base$ + ".Formant"
    endif

    selectObject: strs
    nocheck Read from file: wav$
    nSnd = numberOfSelected("Sound")

    if nSnd < 1
      appendInfoLine: "EXPORT_FAIL ", name$
    else
      sound = selected("Sound")

      ## ---------------- Pitch（dims=formant 时跳过）----------------
      if dm$ <> "formant"
        selectObject: sound
        if pm$ = "raw"
          nocheck To Pitch (raw autocorrelation): timeStep, f0min, pc, 15, 0, pSil, pVoi, pOct, pJmp, pVuv
        elsif pm$ = "filtered"
          nocheck To Pitch (filtered autocorrelation): timeStep, f0min, pc, 15, 0, pAtt, pSil, pVoi, pOct, pJmp, pVuv
        else
          # 默认 = 滤波自相关（2026-09-25 用户拍板：基频抽取统一用 filtered AC，
          # 与主批量 get_pitch.praat 的 pitchMethod=0 一致）。第 3 参在 filtered 里是
          # pitch top（用清单里的 f0 上限），其余取 Praat 标准值。
          nocheck To Pitch (filtered autocorrelation): timeStep, f0min, pc, 15, 0, 0.03, 0.09, 0.5, 0.055, 0.35, 0.14
        endif
        nF0 = numberOfSelected("Pitch")
        if nF0 >= 1
          pch = selected("Pitch")
          nocheck Save as text file: pitchOut$
          Remove
          appendInfoLine: "EXPORT_PITCH ", name$
        else
          appendInfoLine: "EXPORT_NOPITCH ", name$
        endif
      endif

      ## ---------------- Formant（dims=pitch 时跳过）----------------
      if dm$ <> "pitch"
        selectObject: sound
        nocheck To Formant (burg): timeStep, nF, fc, 0.025, 50
        nFm = numberOfSelected("Formant")
        if nFm >= 1
          fmo = selected("Formant")
          nocheck Save as text file: fmtOut$
          Remove
          appendInfoLine: "EXPORT_FMT ", name$
        else
          appendInfoLine: "EXPORT_NOFMT ", name$
        endif
      endif

      selectObject: sound
      Remove
    endif
  else
    # 清单行格式不对（缺参数）—— 跳过，不影响其它行
    appendInfoLine: "EXPORT_BADLINE ", line$
  endif
endfor

appendInfoLine: "EXPORT_DONE"
