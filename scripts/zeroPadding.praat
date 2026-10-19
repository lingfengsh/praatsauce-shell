### Pad derived signal vectors with undefined (NaN) to ensure that they are
### equal length
### Almost certainly overthinking this
###
### 本项目补丁（2026-10-18）：补位值由 0 改为 undefined（= NaN）。
### 0 同时是合法测量值（谱幅度 0 dB、SoE 0 等），下游无法区分「这一帧没测到」
### 与「真测到 0」，补出来的 0 会被统计当成真实值拉低均值、污染分布。
### Praat 没有 undefined#(n)，用 zero#(n) * undefined 得到 n 个 undefined
### （0 * undefined = undefined）。补位个数可能算出 0，而 zero#(0) 会报错，
### 故三处补位都先判正数。

procedure zeroPadding: .res#, .numFrames, .mostFrames, .times#, .firstFrame,
  ... .lastFrame, .timeStep, .equidistant, .start

if .equidistant <> 0 & .start > 0
  .res# = .res#
else
  if min(.times#) > .firstFrame & .numFrames < .mostFrames
    diffFrames = (min(.times#) - .firstFrame) / .timeStep
    if round(diffFrames) + size(.res#) > .mostFrames
      discrepancy = (round(diffFrames) + size(.res#)) - .mostFrames
      diffFrames = diffFrames - discrepancy
    endif
    if round(diffFrames) > 0
      padStart# = zero#( round(diffFrames) ) * undefined
      .res# = combine# (padStart#, .res#)
      .numFrames = size(.res#)
    endif
  else
    .res# = .res#
  endif

  if max(.times#) < .lastFrame & .numFrames < .mostFrames
    diffFrames = (.lastFrame - max(.times#)) / .timeStep
    if round(diffFrames) + size(.res#) > .mostFrames
      discrepancy = (round(diffFrames) + size(.res#)) - .mostFrames
      diffFrames = diffFrames - discrepancy
    endif
    if round(diffFrames) > 0
      padEnd# = zero#( round(diffFrames) ) * undefined
      .res# = combine# (.res#, padEnd#)
    endif
  else
    .res# = .res#
  endif

endif

if size(.res#) < .mostFrames
  discrepancy = .mostFrames - size(.res#)
  .res# = combine# (.res#, zero#(discrepancy) * undefined)
endif

endproc
