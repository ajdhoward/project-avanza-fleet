import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { DarkTheme } from "@react-navigation/native";
import * as Notifications from "expo-notifications";
import React, { useEffect } from "react";
import { registerPushToken } from "@/lib/api";

Notifications.setNotificationHandler({
	handleNotification: async () => ({
		shouldShowBanner: true,
		shouldShowList: true,
		shouldPlaySound: true,
		shouldSetBadge: false,
	}),
});

const theme = {
	...DarkTheme,
	colors: {
		...DarkTheme.colors,
		primary: "#22c55e",
		background: "#060913",
		card: "#0d1526",
		border: "#1c2a45",
		text: "#e6edf7",
	},
};

export default function RootLayout() {
	useEffect(() => {
		registerPushToken();
	}, []);
	return (
		<>
			<StatusBar style="light" />
			<Stack
				screenOptions={{
					headerStyle: { backgroundColor: theme.colors.card },
					headerTintColor: theme.colors.text,
					contentStyle: { backgroundColor: theme.colors.background },
				}}
			>
				<Stack.Screen name="index" options={{ title: "Avanza Control Matrix" }} />
			</Stack>
		</>
	);
}
