### Process formants_narrow files from VoxCommunis to get average vowel formants by language
### E. Chodroff
### Dec 24 2023
dir <- c("./vowel-formant-averages/formants_narrow/")
files <- list.files(dir)

d <- data.frame()
for (i in 1:length(files)) {
  di <- read_delim(paste0(dir, files[i]))
  di$lang <- gsub("_avg_formants.tsv", "", files[i])
  d <- rbind(d, di)
}

# convert hertz to ERB
hz2erb <- function(x) {
  output <- (.0043 * x) + 1
  output <- 21.4 * log10(output)
  return(output)
}

d$mean_f1_erb <- hz2erb(d$mean_f1)
d$mean_f2_erb <- hz2erb(d$mean_f2)

avgs <- d %>% group_by(lang, vowel, setting) %>% 
  summarise(meanf1hz = mean(mean_f1), meanf2hz = mean(mean_f2), 
            meanf1erb = mean(mean_f1_erb), meanf2erb = mean(mean_f2_erb), 
            total = n())

write.csv(avgs, "~/Desktop/voxcommunis_vowel_averages.csv", quote = F, row.names = F)
vowel_i <- subset(avgs, vowel == "i")
high_i <- subset(vowel_i, setting == "high")
low_i <- subset(vowel_i, setting == "low")

ggplot(vowel_i) + 
  geom_line(aes(x = meanf2hz, y = meanf1hz, group = lang), color = "gray") + 
  theme_minimal(23) + 
  theme(legend.position = 'bottom') + 
  geom_text_repel(data = high_i, aes(x = meanf2hz, y = meanf1hz, label = lang), box.padding = 0.8, max.overlaps =30) +
  geom_point(aes(x = meanf2hz, y = meanf1hz, color = setting)) + 
  scale_x_reverse(position = "top") + 
  scale_y_reverse(position = "right") + 
  xlab("mean F2 (Hz)") + ylab("mean F1 (Hz)") + 
  annotate("text", x = 1650, y = 325, size = 15, label = "[i]") 
  #+ 
 # guides(position = "left") #+ 
  #geom_point(data = subset(d, lang == "sorbian" & vowel == "i"), aes(x = mean_f2_erb, y = mean_f1_erb, shape = setting))
ggsave("~/Desktop/CommonVoice_i.pdf", plot = last_plot(), height = 8, width = 10, dpi = 300)

ggplot(vowel_i) + 
  geom_line(aes(x = meanf2erb, y = meanf1erb, group = lang), color = "gray") + 
  theme_minimal(23) + 
  theme(legend.position = 'bottom') + 
  geom_text_repel(data = high_i, aes(x = meanf2erb, y = meanf1erb, label = lang), box.padding = 0.8, max.overlaps =30) +
  geom_point(aes(x = meanf2erb, y = meanf1erb, color = setting)) + 
  scale_x_reverse(position = "top") + 
  scale_y_reverse(position = "right") + 
  xlab("mean F2 (ERB)") + ylab("mean F1 (ERB)")  + 
  annotate("text", x = 19.25, y = 8.25, size = 15, label = "[i]") 
#+ 
# guides(position = "left") #+ 
#geom_point(data = subset(d, lang == "sorbian" & vowel == "i"), aes(x = mean_f2_erb, y = mean_f1_erb, shape = setting))
ggsave("~/Desktop/CommonVoice_i_erb.pdf", plot = last_plot(), height = 8, width = 10, dpi = 300)


vowel_u <- subset(avgs, vowel == "u")
high_u <- subset(vowel_u, setting == "high")
low_u <- subset(vowel_u, setting == "low")

ggplot(vowel_u) + 
  geom_line(aes(x = meanf2, y = meanf1, group = lang), color = "gray") + 
  theme_minimal(23) + 
  geom_text_repel(data = high_u, aes(x = meanf2, y = meanf1, label = lang), box.padding = 0.8, max.overlaps =30) +
  geom_point(aes(x = meanf2, y = meanf1, color = setting)) + 
  scale_x_reverse(position = "top") + 
  scale_y_reverse(position = "right") + 
  xlab("mean F2 (ERB)") + ylab("mean F1 (ERB)") + 
  guides(position = "left")
ggsave("~/Desktop/CommonVoice_u_erb.pdf", plot = last_plot(), height = 6, width = 10, dpi = 300)


vowel_a <- subset(avgs, vowel == "a")
high_a <- subset(vowel_a, setting == "high")
low_a <- subset(vowel_a, setting == "low")

ggplot(vowel_a) + 
  geom_line(aes(x = meanf2, y = meanf1, group = lang), color = "gray") + 
  theme_minimal(23) + 
  geom_text_repel(data = high_a, aes(x = meanf2, y = meanf1, label = lang), box.padding = 0.8, max.overlaps =30) +
  geom_point(aes(x = meanf2, y = meanf1, color = setting)) + 
  scale_x_reverse(position = "top") + 
  scale_y_reverse(position = "right") + 
  xlab("mean F2 (ERB)") + ylab("mean F1 (ERB)") + 
  guides(position = "left")
ggsave("~/Desktop/CommonVoice_a_erb.pdf", plot = last_plot(), height = 6, width = 10, dpi = 300)


vowels <- rbind(vowel_i, vowel_a, vowel_u)
high_vowels <- rbind(high_i, high_a, high_u)

ggplot(vowels) + 
  #geom_line(aes(x = meanf2, y = meanf1, group = lang), color = "gray") + 
  geom_line(data = vowel_i, aes(x = meanf2, y = meanf1, group = lang), color = "gray") + 
  geom_line(data = vowel_a, aes(x = meanf2, y = meanf1, group = lang), color = "gray") + 
  geom_line(data = vowel_u, aes(x = meanf2, y = meanf1, group = lang), color = "gray") +
  theme_minimal(23) + 
  #geom_text_repel(data = high_i, aes(x = meanf2, y = meanf1, label = lang), box.padding = 0.8, max.overlaps =30) +
  geom_point(aes(x = meanf2, y = meanf1, color = setting)) + 
  scale_x_reverse(position = "top") + 
  scale_y_reverse(position = "right") + 
  xlab("mean F2 (ERB)") + ylab("mean F1 (ERB)") + 
  guides(position = "left")
ggsave("~/Desktop/CommonVoice_iau_erb.pdf", plot = last_plot(), height = 6, width = 10, dpi = 300)


