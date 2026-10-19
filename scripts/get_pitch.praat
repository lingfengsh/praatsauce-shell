### Get pitch values

procedure pitch: .timeStep, .f0min, .f0max, .start, .end, .method, .windowShape,
  ... .maxNoCandidates, .silenceThreshold, .voicingThreshold, .octaveCost,
  ... .octaveJumpCost, .voicedUnvoicedCost, .killOctaveJumps,
  ... .save, .saveDir$, .read, .readDir$, .basefn$

## extract padded snippet
## one analysis window corresponds ROUGHLY to three pitch cycles (i.e.
## 3 * pitch floor), because for some reason this number is rounded in some
## arcane fashion.

snd = selected("Sound")
dur = Get total duration
## ⚠️ @snippet 内部用全局变量 dur 表示「片段结束时间」，会把这里的 dur 覆盖掉。
## 2026-10-18：整段时长必须存进过程变量，后面判「是否整段 / 对象时长是否够」都读它。
.wholeDur = dur

if .windowShape = 0
  cyclesPerWindow = 3
else
  cyclesPerWindow = 6
endif

@snippet: .start, .end, ((cyclesPerWindow * (1 / .f0min)) / 2) + (.timeStep / 2)
snippet = selected("Sound")

## 本项目补丁（2026-09-30，两件）：
## ① 路径对齐：原来 pitchRead/SaveDir 被设为 <inputDir>/measure，再拼 basefn(=子目录/主名)
##    得到 <inputDir>/measure/子目录/主名，与审计写的 <inputDir>/子目录/measure/主名 错位
##    （measure 与子目录顺序反了）—— 批量因此找不到审计对象、被迫重算并写到平行文件夹。
##    现 Dir 只传 inputDir 根（见 server.py _prepare），这里用 rindex 把 measure/ 插到主名之前，
##    与 review_export.praat / 第四步 object_path 完全一致，批量即可复用审计对象（read=1 命中、不重算）。
## ② 读回自愈：请求读且文件存在时，用 nocheck 读回（坏文件也不中断），比对对象数；
##    若读不出（0 字节/截断，通常中断存盘遗留）则改走重算并覆盖，避免坏文件被永久信任成空白。

## —— 先按「<wav所在目录>/measure/<主名>」拼出对象路径（basefn 可能带子目录）——
.objPath$ = .readDir$
.slash = rindex(.basefn$, "/")
if .slash > 0
  .stem$ = right$(.basefn$, length(.basefn$) - .slash)
  .objPath$ = .objPath$ + left$(.basefn$, .slash) + "/measure/" + .stem$ + ".Pitch"
else
  .objPath$ = .objPath$ + "measure/" + .basefn$ + ".Pitch"
endif

if .read = 0 or fileReadable(.objPath$) = 0
  .needCompute = 1
else
  .before = numberOfSelected("Pitch")
  nocheck Read from file: .objPath$
  if numberOfSelected("Pitch") = .before
    .needCompute = 1
  ## 读出 0 个对象 → 文件损坏，改重算覆盖（自愈）
  else
    pitchOrg = selected("Pitch")
    ## ③ 网格校验（2026-10-02）：读入对象的帧步必须与本次 timeStep 一致。
    ##    换参数（如 timeStep 0.005→0.015）重跑时，旧缓存若被原样读回，
    ##    会导致下游按帧号补 0 对齐（praatSauce zeroPadding）→ f0/H1-H2 时间轴扭曲。
    ##    dx 不一致即视为过期缓存，删掉重算覆盖（审阅保存的轨迹本身完整，无需插值）。
    .nxr = Get number of frames
    if .nxr < 2
      selectObject: snippet
      removeObject: pitchOrg
      .needCompute = 1
    else
      .t1 = Get time from frame number: 1
      .t2 = Get time from frame number: 2
      ## 2026-10-18 追加：对象时长必须覆盖整段音频。旧版分段批量会把 .Pitch 覆盖成
      ## 某一个标注段的片段（只有几百毫秒），这种坏对象网格步长仍可能是对的，
      ## 只查 dx 会把它当有效缓存信任 → 后续 F0 全空。这里一并判时长，命中即重算。
      .objDur = Get total duration
      if abs((.t2 - .t1) - .timeStep) > 0.0005 or .objDur < .wholeDur * 0.9
        selectObject: snippet
        removeObject: pitchOrg
        .needCompute = 1
      else
        .needCompute = 0
      endif
    endif
  endif
endif

## 本项目补丁（2026-10-18）：分段测量时，计算与保存都必须针对「整段声音」。
## 按 TextGrid 分段时，每个区间都会进计算分支，用「该区间的片段」重算并 Save 到
## 同一个 .Pitch —— 最后一个区间（往往是最长的 sil 静音段）会把整段对象覆盖成
## 一个几百毫秒的片段，于是批量 out.tsv 里 f0 / H1 / H2 全空，界面报「基频检出异常」。
## 修法：只要不是整段，就选回整段 Sound 计算并保存整段对象；后续区间读回即可。
.wholeFile = 1
if .start > 0.0001 or .end < .wholeDur - 0.0001
  .wholeFile = 0
endif

if .needCompute = 1

  snippetDur = Get total duration
  if .wholeFile = 0
    selectObject: snd
    calcDur = .wholeDur
  else
    calcDur = snippetDur
  endif
  if calcDur < (1 / .f0min) * cyclesPerWindow
    .f0min = ((1 / calcDur) * cyclesPerWindow) + 1
  endif

  if .method = 0

    ## untouched argument is the undocumented attenuation at ceiling preprocessing

    pitchOrg = noprogress To Pitch (filtered ac): .timeStep, .f0min, .f0max,
      ... .maxNoCandidates, .windowShape, 0.03, .silenceThreshold,
      ... .voicingThreshold, .octaveCost, .octaveJumpCost, .voicedUnvoicedCost

  elsif .method = 1

    pitchOrg = noprogress To Pitch (raw cc): .timeStep, .f0min, .f0max,
      ... .maxNoCandidates, .windowShape, .silenceThreshold, .voicingThreshold,
      ... .octaveCost, .octaveJumpCost, .voicedUnvoicedCost

  else

    pitchOrg = noprogress To Pitch (raw ac): .timeStep, .f0min, .f0max,
    ... .maxNoCandidates, .windowShape, .silenceThreshold, .voicingThreshold,
    ... .octaveCost, .octaveJumpCost, .voicedUnvoicedCost

  endif

  if .save <> 0

    Save as text file: .objPath$

  endif

endif

## Kill octave jumps
## this procedure also removes candidates from the resulting object,
## which is why it is done before potentially saving a pitch file
## seems nonsensical to write pitch files to disk without candidates

if .killOctaveJumps <> 0

  pitchFilt = noprogress Kill octave jumps

endif

.meanF0 = Get mean: 0, 0, "Hertz"

## grab all values as a vector

.f0# = List values in all frames: "Hertz"

## grab frame times and number of frames

.times# = List all frame times
.numFrames = Get number of frames

if .start > 0 | .end < dur

  @restrictInterval: .times#, .f0#, .start, .end

  .times# = restrictInterval.newTimes#
  .f0# = restrictInterval.newVals#
  .numFrames = size(restrictInterval.newTimes#)

endif

## clean up

removeObject: pitchOrg, snippet
if .killOctaveJumps <> 0
  removeObject: pitchFilt
endif

selectObject: snd

endproc
