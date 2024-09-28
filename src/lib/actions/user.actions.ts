"use server";

import { avatarPlaceholderUrl } from "@/constants";
import { createAdminClient, createSessionClient } from "@/lib/appwrite";
import { appwriteConfig } from "@/lib/appwrite/config";
import { parseStringify } from "@/lib/utils";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ID, Query } from "node-appwrite";

/**
 * Получает пользователя из коллекции по email.
 * @param email Email пользователя.
 * @returns Документ пользователя или null, если пользователь не найден.
 */
const getUserByEmail = async (email: string) => {
  try {
    const { databases } = await createAdminClient();
    const result = await databases.listDocuments(
      appwriteConfig.databaseId,
      appwriteConfig.usersCollectionId,
      [Query.equal("email", [email])]
    );

    return result.total > 0 ? result.documents[0] : null;
  } catch (error) {
    handleError(error, "Failed to get user by email");
  }
};

/**
 * Универсальный обработчик ошибок.
 * Логирует ошибку и выбрасывает её дальше.
 * @param error Объект ошибки.
 * @param message Сообщение для логирования.
 */
const handleError = (error: unknown, message: string) => {
  console.error(message, error);
  throw new Error(message);
};

/**
 * Отправляет OTP на email пользователя.
 * @param email Email для отправки OTP.
 * @returns Идентификатор пользователя.
 */
export const sendEmailOTP = async ({ email }: { email: string }) => {
  try {
    const { account } = await createAdminClient();
    const session = await account.createEmailToken(ID.unique(), email);

    if (!session?.userId) {
      throw new Error("Email token creation failed");
    }

    return session.userId;
  } catch (error) {
    handleError(error, "Failed to send email OTP");
  }
};

/**
 * Создаёт новый аккаунт, если пользователь отсутствует.
 * @param fullName Полное имя пользователя.
 * @param email Email пользователя.
 * @returns ID созданного аккаунта.
 */
export const createAccount = async ({
  fullName,
  email,
}: {
  fullName: string;
  email: string;
}) => {
  try {
    const existingUser = await getUserByEmail(email);

    // Создать аккаунт, если пользователь не найден
    if (!existingUser) {
      const accountId = await sendEmailOTP({ email });
      if (!accountId) throw new Error("Failed to send an OTP");

      const { databases } = await createAdminClient();
      await databases.createDocument(
        appwriteConfig.databaseId,
        appwriteConfig.usersCollectionId,
        ID.unique(),
        {
          fullName,
          email,
          avatar: avatarPlaceholderUrl,
          accountId,
        }
      );

      return parseStringify({ accountId });
    }

    return parseStringify({ accountId: existingUser.accountId });
  } catch (error) {
    handleError(error, "Failed to create account");
  }
};

/**
 * Верифицирует OTP и создаёт пользовательскую сессию.
 * @param accountId ID аккаунта.
 * @param password OTP пароль.
 * @returns ID созданной сессии.
 */
export const verifySecret = async ({
  accountId,
  password,
}: {
  accountId: string;
  password: string;
}) => {
  try {
    const { account } = await createAdminClient();
    const session = await account.createSession(accountId, password);

    if (!session?.secret) {
      throw new Error("Failed to create session");
    }

    (await cookies()).set("appwrite-session", session.secret, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: true,
    });

    return parseStringify({ sessionId: session.$id });
  } catch (error) {
    handleError(error, "Failed to verify OTP");
  }
};

/**
 * Получает текущего авторизованного пользователя.
 * @returns Документ текущего пользователя или null.
 */
export const getCurrentUser = async () => {
  try {
    const { databases, account } = await createSessionClient();
    const result = await account.get();

    const user = await databases.listDocuments(
      appwriteConfig.databaseId,
      appwriteConfig.usersCollectionId,
      [Query.equal("accountId", result.$id)]
    );

    if (user.total <= 0) return null;

    return parseStringify(user.documents[0]);
  } catch (error) {
    handleError(error, "Failed to get current user");
  }
};

/**
 * Завершает текущую сессию пользователя.
 */
export const signOutUser = async () => {
  try {
    const { account } = await createSessionClient();
    await account.deleteSession("current");
    (await cookies()).delete("appwrite-session");
  } catch (error) {
    handleError(error, "Failed to sign out user");
  } finally {
    redirect("/sign-in");
  }
};

/**
 * Авторизует пользователя по email.
 * @param email Email пользователя.
 * @returns ID аккаунта пользователя.
 */
export const signInUser = async ({ email }: { email: string }) => {
  try {
    const existingUser = await getUserByEmail(email);

    if (existingUser) {
      await sendEmailOTP({ email });
      return parseStringify({ accountId: existingUser.accountId });
    }

    return parseStringify({ accountId: null, error: "User not found" });
  } catch (error) {
    handleError(error, "Failed to sign in user");
  }
};